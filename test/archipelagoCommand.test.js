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
const slashRegistry = require('../helpers/slashRegistry.js');
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

// --- !ap next -----------------------------------------------------------------------------------
//
// What the reply says for each slot, and in what order. The reply for someone holding many slots
// used to follow claim order, which says nothing about where to go first, and the message limit
// then cut whichever slots happened to be claimed last. Sorted, the first block is the nearest
// thing to do and the ones cut are the furthest along. A slot with nothing to do gets no block at
// all when several are asked about, only its name in the footer, so it cannot crowd out one that
// has something.
//
// Each slot lists only its soonest sphere with anything in logic and counts the spheres after it.
// One list running across spheres read as an arbitrary slice of hundreds of names, with nothing
// in the reply saying which sphere any of them was in.
//
// The wording carries which of two very different answers a slot got. One comes from the seed's
// own logic, run against the items the slot has received. The other is sphere 1 alone, the
// fallback when that logic is unavailable, and read as the logic answer it looks like a slot with
// almost nothing to do. So each block says which it is, and the footer says why logic was missing.
//
// suggestNextAll is stubbed: this is about what the command renders, and how each slot's answer
// is worked out is covered in archipelagoSuggest.test.js. The status message is edited into the
// answer, and in this action `edit` gets a bare string, so the edits are what has to be captured.

// Held once, so a test that asks twice restores the real one and not the first stub.
const realSuggestNextAll = monitor.suggestNextAll;

async function claimAll(slots) {
    const watch = await addWatch(slots);
    for (const slot of slots) await run('claim', slot);
    return watch;
}

// `wait` has the stub call onWait before answering, the way a worker that is still starting does.
async function askNext(t, outcome, { wait = false, args = ['next'] } = {}) {
    const calls = [];
    monitor.suggestNextAll = async (id, wanted, options) => {
        calls.push({ id, wanted, options });
        if (wait) await options.onWait();
        return outcome;
    };
    t.after(() => { monitor.suggestNextAll = realSuggestNextAll; });

    const edits = [];
    const msg = fakeMessage();
    msg.channel.send = async (payload) => {
        msg.sent.push(payload);
        return { edit: async (text) => { edits.push(text); return {}; } };
    };
    await ap.command.process(msg, ...args);
    return { msg, edits, calls, final: edits.length ? edits[edits.length - 1] : null };
}

// One slot's answer in the shape suggestNextAll gives it: `locations` only the soonest sphere with
// anything in logic, `later` a count for each sphere after it, `total` everything in logic and
// `open` everything unchecked. `later` is written here as [sphere, count] pairs to keep tests short.
const inLogic = (slot, locations, open, sphere = 1, later = []) => {
    const groups = later.map(([s, count]) => ({ sphere: s, count }));
    return {
        ok: true, slot, mode: 'logic', locations, sphere: locations.length > 0 ? sphere : null,
        later: groups, total: locations.length + groups.reduce((n, g) => n + g.count, 0), open
    };
};
// Enough names to run past a block's cap, numbered so each line can be told apart.
const numbered = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const bullets = (names) => names.map(name => `• ${name}`).join('\n');
const sphereOne = (slot, locations, open, why) => ({
    ok: true, slot, mode: 'sphere1', source: 'multidata', locations,
    sphere: locations.length > 0 ? 1 : null, total: locations.length, open, why
});
// A spoiler's Playthrough lists only the placements the seed's completion needs, so an answer
// from one has no count of what is unchecked.
const fromSpoiler = (slot, locations, why) => ({ ...sphereOne(slot, locations, null, why), source: 'spoiler' });
const answered = (...results) => ({ ok: true, logic: { ok: true }, results });

// The logic's own detail names places on the host, which a public reply has no business showing.
// No markdown characters in it, so one check catches the raw text and an escaped copy alike.
const INSTALL = 'D:/Games/AP-0.6.7';
const NOT_HERE = { ok: false, reason: 'not-generated-here', detail: `no output/AP_Seed_CMD.zip in ${INSTALL}` };

const LOADING = '🧭 Loading this seed\'s logic from the Archipelago install. About a minute the first time…';
const LEAD = '_In logic with the items each slot has received, by the seed\'s own rules; earliest sphere first. ';

test('!ap next lists claimed slots earliest sphere with something in logic first', async (t) => {
    const slots = ['ZackWord', 'ZackStuck', 'ZackEarly', 'ZackDone', 'ZackBanner'];
    await claimAll(slots);

    const canned = {
        ZackWord:   inLogic('ZackWord', ['Word Loc'], 3, 3),
        ZackStuck:  inLogic('ZackStuck', [], 5),
        ZackEarly:  inLogic('ZackEarly', ['Early Loc'], 10, 1),
        ZackDone:   { ok: false, slot: 'ZackDone', reason: 'nothing-left' },
        ZackBanner: inLogic('ZackBanner', ['Banner Loc'], 2, 3)
    };
    const reply = await askNext(t, answered(...slots.map(name => canned[name])));

    assert.deepStrictEqual(reply.calls[0].wanted, slots, 'every claimed slot was asked about, in claim order');
    const answer = reply.final;
    assert.ok(answer, 'the status message was edited into the answer');
    const at = (name) => answer.indexOf(`**${name}**`);

    // Sphere 1, then the two sphere-3 slots by name.
    assert.ok(at('ZackEarly') >= 0, answer);
    assert.ok(at('ZackEarly') < at('ZackBanner'), 'sphere 1 before sphere 3');
    assert.ok(at('ZackBanner') < at('ZackWord'), 'a tie in sphere goes by name');

    // Nothing in logic yet and nothing left are named after every block rather than given one.
    const footer = answer.slice(answer.lastIndexOf('\n_'));
    for (const name of ['ZackStuck', 'ZackDone']) {
        assert.strictEqual(at(name), -1, `${name} has no block: ${answer}`);
        assert.ok(footer.includes(`\`${name}\``), `${name} is named in the footer: ${answer}`);
    }
});

test('one slot answered from the seed\'s logic names its soonest sphere, lists it and says how much is still locked', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate_1', 'Door B'], 9, 2, [[3, 1]])));

    assert.strictEqual(reply.edits.length, 1, 'no loading line when the logic was already up');
    assert.ok(reply.final.startsWith('🧭 **What is in logic**\n'), reply.final);
    assert.ok(reply.final.includes(
        '**ZackWord** — sphere 2: 2 in logic\n• Crate\\_1\n• Door B\n_Also in logic: sphere 3 (1) · 6 still locked_\n'),
        `the sphere, its count and every location, markdown escaped: ${reply.final}`);
    assert.ok(!reply.final.includes('Sphere 1 only'), reply.final);
});

test('one slot lists 15 names from its soonest sphere and counts each later sphere, with thousands separators', async (t) => {
    await claimAll(['ZackWarhammer']);
    const reply = await askNext(t, answered(
        inLogic('ZackWarhammer', numbered('Empire', 56), 2929, 1, [[2, 1175], [3, 2]])));

    assert.ok(reply.final.includes(
        '**ZackWarhammer** — sphere 1: 56 in logic\n' +
        `${bullets(numbered('Empire', 15))}\n` +
        '• …41 more in sphere 1\n' +
        '_Also in logic: sphere 2 (1,175), sphere 3 (2) · 1,696 still locked_\n'), reply.final);
    assert.ok(!reply.final.includes('Empire 16'), reply.final);
});

// A location the sphere data does not place is still in logic; there is just no sphere to name.
test('a later group with no known sphere is counted last without printing null', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate'], 6, 1, [[2, 2], [null, 3]])));

    assert.match(reply.final, /_Also in logic: sphere 2 \(2\), [^_(]+ \(3\)_\n/, reply.final);
    assert.ok(!/\bnull\b|NaN|undefined/.test(reply.final), `a missing sphere was printed: ${reply.final}`);
});

test('one slot with nothing in logic past its soonest sphere says so beside what is still locked', async (t) => {
    await claimAll(['ZackDig']);
    const reply = await askNext(t, answered(inLogic('ZackDig', numbered('Chunk', 20), 3845, 2)));

    assert.ok(reply.final.includes(
        '**ZackDig** — sphere 2: 20 in logic\n' +
        `${bullets(numbered('Chunk', 15))}\n` +
        '• …5 more in sphere 2\n' +
        '_Nothing later in logic yet · 3,825 still locked_\n'), reply.final);
});

test('a slot with everything unchecked in logic leaves the locked count out rather than saying 0', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate'], 3, 1, [[2, 2]])));

    assert.ok(reply.final.includes('**ZackWord** — sphere 1: 1 in logic\n• Crate\n_Also in logic: sphere 2 (2)_\n'), reply.final);
    assert.ok(!reply.final.includes('locked'), reply.final);
});

test('one slot with nothing later and nothing locked ends at its last name', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate', 'Door'], 2)));

    assert.ok(reply.final.includes(`**ZackWord** — sphere 1: 2 in logic\n• Crate\n• Door\n${LEAD}`), reply.final);
    assert.ok(!reply.final.includes('Nothing later'), reply.final);
    assert.ok(!reply.final.includes('locked'), reply.final);
});

// "…1 more" would take the line the one name does.
test('one slot shows a 16th name rather than a line saying 1 more', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', numbered('Crate', 16), 16)));

    assert.ok(reply.final.includes(`**ZackWord** — sphere 1: 16 in logic\n${bullets(numbered('Crate', 16))}\n${LEAD}`),
        reply.final);
    assert.ok(!reply.final.includes('more in sphere'), reply.final);
});

test('a slot with nothing in logic yet says how much is still locked', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', [], 1234)));

    assert.ok(reply.final.includes('**ZackWord** — nothing in logic yet; 1,234 still locked.'), reply.final);
    // Still an answer from the seed's own rules, just an empty one, so the lead stays.
    assert.ok(reply.final.includes(LEAD), reply.final);
});

test('several slots each get their soonest sphere, later and locked counts on one line, then three names', async (t) => {
    await claimAll(['ZackWord', 'ZackWarhammer']);
    const reply = await askNext(t, answered(
        inLogic('ZackWord', numbered('Crate', 4), 326),
        inLogic('ZackWarhammer', numbered('Empire', 56), 2929, 1, [[2, 1175], [3, 2]])));

    assert.ok(reply.final.startsWith('🧭 **What is in logic across 2 of your slots**\n'), reply.final);
    assert.ok(reply.final.includes(
        '**ZackWarhammer** — sphere 1: 56 in logic · +1,177 later · 1,696 locked\n' +
        '• Empire 1\n• Empire 2\n• Empire 3\n• …53 more\n\n'), reply.final);
    // "…1 more" would take the line the fourth name does.
    assert.ok(reply.final.includes(
        '**ZackWord** — sphere 1: 4 in logic · +0 later · 322 locked\n' +
        `${bullets(numbered('Crate', 4))}\n${LEAD}`), reply.final);
    assert.ok(!reply.final.includes('Also in logic'), reply.final);
});

test('several slots leave out the ones with nothing in logic yet and name them in the footer', async (t) => {
    await claimAll(['ZackWord', 'ZackRisk', 'ZackStuck']);
    const reply = await askNext(t, answered(
        inLogic('ZackWord', ['Crate'], 2),
        inLogic('ZackRisk', [], 774),
        inLogic('ZackStuck', [], 73)));

    assert.ok(reply.final.startsWith('🧭 **What is in logic across 1 of your slots**\n'),
        `only the slot listed is counted: ${reply.final}`);
    for (const name of ['ZackRisk', 'ZackStuck']) assert.ok(!reply.final.includes(`**${name}**`), reply.final);
    assert.ok(reply.final.endsWith(
        `${LEAD}Nothing here says what is in them. 2 with nothing in logic yet: \`ZackRisk\`, \`ZackStuck\`._`), reply.final);
});

test('the footer names at most ten slots with nothing in logic yet and counts the rest', async (t) => {
    const idle = Array.from({ length: 13 }, (_, i) => `ZackIdle${String(i + 1).padStart(2, '0')}`);
    await claimAll(['ZackWord', ...idle]);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate'], 2), ...idle.map(name => inLogic(name, [], 5))));

    const named = idle.slice(0, 10).map(name => `\`${name}\``).join(', ');
    assert.ok(reply.final.endsWith(` 13 with nothing in logic yet: ${named} and 3 more._`), reply.final);
    assert.ok(!reply.final.includes('ZackIdle11'), reply.final);
});

test('several slots name the ones with nothing left to check in the footer, and one slot still says so on its line', async (t) => {
    await claimAll(['ZackWord', 'ZackDone']);
    const nothingLeft = { ok: false, slot: 'ZackDone', reason: 'nothing-left' };

    const several = await askNext(t, answered(inLogic('ZackWord', ['Crate'], 2), nothingLeft));
    assert.ok(several.final.startsWith('🧭 **What is in logic across 1 of your slots**\n'), several.final);
    assert.ok(!several.final.includes('**ZackDone**'), several.final);
    assert.ok(several.final.endsWith(' 1 with nothing left to check: `ZackDone`._'), several.final);

    const one = await askNext(t, answered(nothingLeft), { args: ['next', 'ZackDone'] });
    assert.ok(one.final.includes('**ZackDone** — nothing left to check.'), one.final);
});

test('when no slot asked about has anything in logic, the header says so rather than counting none', async (t) => {
    await claimAll(['ZackBanner', 'ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackBanner', [], 5), inLogic('ZackWord', [], 7)));

    assert.ok(reply.final.startsWith('🧭 **Nothing in logic yet across your 2 slots**\n'), reply.final);
    assert.ok(!reply.final.includes('**Zack'), `no slot has a block: ${reply.final}`);
    assert.ok(!reply.final.includes('more slot(s)'), reply.final);
    assert.ok(reply.final.endsWith(' 2 with nothing in logic yet: `ZackBanner`, `ZackWord`._'), reply.final);
});

// A name the room does not know is a mistake to fix, so it is not folded in with the idle slots.
test('a slot that is not in the multiworld keeps its own line among several', async (t) => {
    await claimAll(['ZackWord', 'ZackGone']);
    const reply = await askNext(t, answered(
        inLogic('ZackWord', ['Crate'], 2),
        { ok: false, slot: 'ZackGone', reason: 'unknown-slot' }));

    // Listed, but not counted as one of "your slots" with anything in logic.
    assert.ok(reply.final.startsWith('🧭 **What is in logic across 1 of your slots**\n'), reply.final);
    assert.ok(reply.final.includes('**ZackGone** — not a slot in this multiworld.'), reply.final);
});

test('one slot with names too long for the message gives up names, never its place in the reply', async (t) => {
    await claimAll(['ZackLong']);
    const long = numbered('A location name long enough that sixteen of them cannot share one Discord message', 16)
        .map(name => `${name} ${'x'.repeat(30)}`);
    const reply = await askNext(t, answered(inLogic('ZackLong', long, 40, 1, [[2, 3], [3, 1], [4, 2]])));

    assert.ok(reply.final.length <= 2000, `${reply.final.length} characters`);
    assert.ok(reply.final.includes('**ZackLong** — sphere 1: 16 in logic'), reply.final);
    assert.match(reply.final, /• …\d+ more in sphere 1/);
    assert.ok(reply.final.includes('_Also in logic: sphere 2 (3), sphere 3 (1), sphere 4 (2) · 18 still locked_'), reply.final);
    assert.ok(reply.final.split('\n').filter(line => line.startsWith('• A location')).length < 16, 'some names were given up');
    assert.ok(!reply.final.includes('more slot(s)'), reply.final);
});

test('the later-sphere line names six spheres and counts the rest', async (t) => {
    await claimAll(['ZackWide']);
    const later = Array.from({ length: 9 }, (_, i) => [i + 2, 1]);
    const reply = await askNext(t, answered(inLogic('ZackWide', ['Crate'], 20, 1, later)));
    assert.ok(reply.final.includes(
        '_Also in logic: sphere 2 (1), sphere 3 (1), sphere 4 (1), sphere 5 (1), sphere 6 (1), sphere 7 (1) and 3 more spheres · 10 still locked_'),
    reply.final);
});

test('a soonest sphere generation gave no number to reads as unknown, with no sphere on its "more" line', async (t) => {
    await claimAll(['ZackNull']);
    const reply = await askNext(t, answered(inLogic('ZackNull', numbered('Loc', 20), 30, null, [[null, 3]])));
    assert.ok(reply.final.includes('**ZackNull** — sphere unknown: 20 in logic'), reply.final);
    assert.ok(reply.final.includes('• …5 more\n'), reply.final);
    assert.ok(reply.final.includes('_Also in logic: sphere unknown (3) · 7 still locked_'), reply.final);
    assert.ok(!/no sphere|null/.test(reply.final), reply.final);
});

test('several slots that all have nothing left to check say so, with no empty line under the header', async (t) => {
    await claimAll(['ZackWord', 'ZackBanner']);
    const reply = await askNext(t, answered(
        { ok: false, slot: 'ZackWord', reason: 'nothing-left' },
        { ok: false, slot: 'ZackBanner', reason: 'nothing-left' }));
    assert.ok(reply.final.startsWith('🧭 **Nothing left to check across your 2 slots**\n_'), reply.final);
    assert.ok(!reply.final.includes('\n\n'), reply.final);
});

test('a reply too long for one message keeps the soonest slots and counts the ones it cut', async (t) => {
    const slots = Array.from({ length: 25 }, (_, i) => `ZackSlot${String(i + 1).padStart(2, '0')}`);
    await claimAll(slots);
    // Spheres run against name and claim order, so keeping either of those would keep the wrong end.
    const reply = await askNext(t, answered(...slots.map((name, i) => inLogic(name, numbered('Loc', 50), 60, 25 - i))));

    assert.ok(reply.final.length <= 2000, `${reply.final.length} characters`);
    const cut = reply.final.match(/\n…and (\d+) more slot\(s\)\.\n_/);
    assert.ok(cut, reply.final);
    const kept = (reply.final.match(/^\*\*ZackSlot/gm) || []).length;
    assert.strictEqual(kept + Number(cut[1]), slots.length, reply.final);
    assert.ok(reply.final.includes('**ZackSlot25**'), `sphere 1 is kept: ${reply.final}`);
    assert.ok(!reply.final.includes('**ZackSlot01**'), `sphere 25 is cut: ${reply.final}`);
});

test('a sphere 1 fallback says so on its block and the footer says why the logic was unavailable', async (t) => {
    await claimAll(['ZackWord', 'ZackBanner']);
    const reply = await askNext(t, {
        ...answered(
            sphereOne('ZackWord', ['Start Chest', 'Start Shop'], 6, NOT_HERE.reason),
            sphereOne('ZackBanner', [], 3, NOT_HERE.reason)
        ),
        logic: NOT_HERE
    });

    assert.ok(reply.final.includes('**ZackWord** — sphere 1 only: 2 open · 4 further in\n• Start Chest\n• Start Shop'),
        reply.final);
    assert.ok(!reply.final.includes('**ZackBanner**'), reply.final);
    assert.ok(reply.final.includes(
        ' Sphere 1 only where the seed\'s own logic is unavailable ' +
        '(this seed was not generated here): it needs nothing, so it is always in logic.' +
        ' 1 with nothing open in sphere 1: `ZackBanner`._'), reply.final);
    assert.ok(!reply.final.includes(INSTALL), `the logic's detail reached the reply: ${reply.final}`);

    // Asked about on its own, the empty fallback is the whole answer, so it keeps its line.
    const one = await askNext(t, { ...answered(sphereOne('ZackBanner', [], 3, NOT_HERE.reason)), logic: NOT_HERE },
        { args: ['next', 'ZackBanner'] });
    assert.ok(one.final.includes('**ZackBanner** — nothing open in sphere 1; 3 further in.'), one.final);
});

test('a sphere 1 fallback block lists its names under the same caps as a logic block, for one slot or several', async (t) => {
    await claimAll(['ZackWord', 'ZackBanner']);
    const fallback = (...results) => ({ ...answered(...results), logic: NOT_HERE });

    const one = await askNext(t, fallback(sphereOne('ZackWord', numbered('Start', 17), 57, NOT_HERE.reason)),
        { args: ['next', 'ZackWord'] });
    assert.ok(one.final.includes(
        '**ZackWord** — sphere 1 only: 17 open · 40 further in\n' +
        `${bullets(numbered('Start', 15))}\n` +
        '• …2 more in sphere 1\n_'), one.final);

    const several = await askNext(t, fallback(
        sphereOne('ZackWord', numbered('Start', 5), 45, NOT_HERE.reason),
        sphereOne('ZackBanner', ['Gate'], 1, NOT_HERE.reason)));
    assert.ok(several.final.includes('**ZackBanner** — sphere 1 only: 1 open\n• Gate\n\n'), several.final);
    assert.ok(several.final.includes(
        '**ZackWord** — sphere 1 only: 5 open · 40 further in\n• Start 1\n• Start 2\n• Start 3\n• …2 more\n_'), several.final);
});

test('a sphere 1 answer from a spoiler lists what is open without a count of what is further in', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, {
        ...answered(fromSpoiler('ZackWord', ['Start Chest', 'Start Shop'], NOT_HERE.reason)),
        logic: NOT_HERE
    });

    assert.ok(reply.final.includes('**ZackWord** — sphere 1 only: 2 open\n• Start Chest\n• Start Shop'), reply.final);
    assert.ok(!reply.final.includes('further in'), reply.final);
    assert.ok(!/\bnull\b|NaN|undefined/.test(reply.final), `a missing count was printed: ${reply.final}`);
});

// Running out of the Playthrough's rows says nothing about the slot, since the rows are only the
// placements completion needs. So it is not "nothing left", and not a count of anything either.
test('a spoiler with nothing in sphere 1 for a slot says only that the spoiler lists nothing', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, { ...answered(fromSpoiler('ZackWord', [], NOT_HERE.reason)), logic: NOT_HERE });

    assert.ok(reply.final.includes('**ZackWord** — nothing open in sphere 1 that the spoiler lists.'), reply.final);
    assert.ok(!reply.final.includes('further in'), reply.final);
    assert.ok(!reply.final.includes('nothing left'), reply.final);
    assert.ok(!/\bnull\b|NaN|undefined/.test(reply.final), `a missing count was printed: ${reply.final}`);
});

test('the footer credits the seed\'s own rules only when some slot was answered from them', async (t) => {
    await claimAll(['ZackWord', 'ZackBanner']);

    // The worker answering for one slot and not vouching for another is the one way a reply
    // mixes the two, and 'unverified' is the reason that comes with it.
    const mixed = await askNext(t, answered(
        inLogic('ZackWord', ['Crate'], 1),
        sphereOne('ZackBanner', ['Start Chest'], 2, 'unverified')
    ));
    assert.ok(mixed.final.includes(`\n${LEAD}Nothing here says what is in them.`), mixed.final);
    assert.ok(mixed.final.includes('unavailable (the rebuild did not match this slot)'), mixed.final);

    // A reason the command has no words for is left out rather than echoed, since it could as
    // easily be a detail naming a path on the host.
    const fallbackOnly = await askNext(t, answered(
        sphereOne('ZackWord', ['Start Chest'], 2),
        sphereOne('ZackBanner', ['Start Shop'], 2, `${INSTALL} is not an install`)
    ));
    assert.ok(!fallbackOnly.final.includes('In logic with the items'), fallbackOnly.final);
    assert.ok(fallbackOnly.final.includes(
        '\n_Nothing here says what is in them. Sphere 1 only where the seed\'s own logic is unavailable: it needs nothing'),
        `no reason it has words for, so no brackets: ${fallbackOnly.final}`);
    assert.ok(!fallbackOnly.final.includes(INSTALL), fallbackOnly.final);

    const nothingLeft = await askNext(t, answered(
        { ok: false, slot: 'ZackWord', reason: 'nothing-left' },
        { ok: false, slot: 'ZackBanner', reason: 'nothing-left' }
    ));
    assert.ok(!nothingLeft.final.includes('In logic with the items'), nothingLeft.final);
    assert.ok(nothingLeft.final.includes('\n_Nothing here says what is in them. 2 with nothing left to check:'), nothingLeft.final);
});

test('a first !ap next that has to wait for the seed\'s logic says so on its status line', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate'], 1)), { wait: true });

    assert.strictEqual(typeof reply.calls[0].options.onWait, 'function', 'the command hands suggestNextAll an onWait');
    assert.match(said(reply.msg), /Working out what is open across your 1 slot\(s\)/);
    assert.strictEqual(reply.edits.length, 2, 'the loading line, then the answer over it');
    assert.strictEqual(reply.edits[0], LOADING);
    assert.ok(reply.final.includes('**ZackWord** — sphere 1: 1 in logic\n• Crate'), reply.final);
});

test('with neither the seed\'s logic nor sphere data, the reply starts with why the logic was unavailable', async (t) => {
    await claimAll(['ZackWord']);
    const needSpheres = (logic) => ({
        ok: false,
        reason: 'need-spheres',
        want: 'data/archipelago/spheres/Seed_CMD.json',
        fallback: 'data/archipelago/spoilers/Seed_CMD.txt',
        logic
    });

    const reply = await askNext(t, needSpheres(NOT_HERE));
    assert.ok(reply.final.startsWith(
        '🧭 I cannot use this seed\'s own logic (this seed was not generated here), ' +
        'and I have no sphere data for it either.\n' +
        'Without the logic I can still list sphere 1, which needs nothing, given sphere data:\n'), reply.final);
    assert.ok(reply.final.includes('`data/archipelago/spoilers/Seed_CMD.txt`'), 'the spoiler path is still named');
    assert.ok(!reply.final.includes(INSTALL), `the logic's detail reached the reply: ${reply.final}`);

    // A worker's own error is where a traceback full of host paths would come from.
    const failed = await askNext(t, needSpheres({
        ok: false,
        reason: 'failed',
        detail: `logic worker stopped: File "${INSTALL}/worlds/generic/Rules.py", line 12`
    }));
    assert.ok(failed.final.startsWith(
        '🧭 I cannot use this seed\'s own logic (it could not be loaded; the bot log says why), '), failed.final);
    assert.ok(!failed.final.includes(INSTALL), `the worker's error reached the reply: ${failed.final}`);

    // No reason to give, so it says only what it knows rather than "cannot use ... ()".
    const bare = await askNext(t, needSpheres({ ok: false }));
    assert.ok(bare.final.startsWith('🧭 I have no sphere data for this multiworld.\nWithout the logic'), bare.final);
});

// Every reason archipelagoLogic.acquire and prepareSuggest give for having no logic. One the
// command has no words for would drop the reply to the bare "no sphere data", which reads as if
// the logic was never tried.
test('every reason the seed\'s logic can be unavailable is put into words, and its detail is not', async (t) => {
    await claimAll(['ZackWord']);
    for (const reason of ['disabled', 'no-seed', 'no-install', 'not-generated-here', 'no-python', 'failed']) {
        const reply = await askNext(t, {
            ok: false,
            reason: 'need-spheres',
            fallback: 'data/archipelago/spoilers/Seed_CMD.txt',
            logic: { ok: false, reason, detail: `${reason} at ${INSTALL}` }
        });
        assert.match(reply.final, /^🧭 I cannot use this seed's own logic \([^)]+\), and I have no sphere data/,
            `${reason}: ${reply.final}`);
        assert.ok(!reply.final.includes(INSTALL), `${reason}: ${reply.final}`);
    }
});

// The picker is where a slash user learns what the command does before running it, and the old
// text promised one slot's earliest sphere when it now answers every claimed slot from the logic.
// Read through buildSpec, since that is what Discord is sent and it cuts a subcommand's description
// at 100 characters.
test('the /ap next picker says it covers every claimed slot unless one is named', () => {
    const spec = slashRegistry.buildSpec('ap', ap.command.slash);
    const next = spec.options.find(o => o.name === 'next');
    assert.ok(next, 'next is a subcommand');
    assert.strictEqual(next.description, 'Unchecked locations in logic for your claimed slots');
    const slot = next.options.find(o => o.name === 'slot');
    assert.strictEqual(slot.required, false);
    assert.strictEqual(slot.description, 'One of your claimed slots (defaults to all of them)');
});

// --- who may run what ---------------------------------------------------------------------------
//
// With ownerId blank isOwner() answers true for everybody, so each of these sets one.

const OWNER = '999999999999999999';
const PLAYER = '333333333333333333';
const OTHER = '444444444444444444';

function asOwnedBot(t) {
    const saved = config.ownerId;
    config.ownerId = OWNER;
    t.after(() => { config.ownerId = saved; });
}

const gated = (msg) => /Only the bot owner can change Archipelago watches/.test(said(msg));

test('a player who is not the owner can ask !ap next about their own slot', async (t) => {
    asOwnedBot(t);
    await addWatch(['ZackWord']);
    await runAs(PLAYER, 'claim', 'ZackWord');

    const real = monitor.suggestNextAll;
    let asked = null;
    monitor.suggestNextAll = async (id, wanted) => {
        asked = wanted;
        return { ok: true, results: wanted.map(slot => ({ ok: false, slot, reason: 'nothing-left' })) };
    };
    t.after(() => { monitor.suggestNextAll = real; });

    const msg = await runAs(PLAYER, 'next');
    assert.ok(!gated(msg), said(msg));
    assert.deepStrictEqual(asked, ['ZackWord']);
});

test('a player who is not the owner can read !ap hints', async (t) => {
    asOwnedBot(t);
    await addWatch(['ZackWord']);
    const msg = await runAs(PLAYER, 'hints');
    assert.ok(!gated(msg), said(msg));
    assert.match(said(msg), /No outstanding hints on watch/);
});

test('a player can set hint pings on their own claim, and not on somebody else\'s', async (t) => {
    asOwnedBot(t);
    const watch = await addWatch(['ZackWord', 'ZackOther']);
    await runAs(PLAYER, 'claim', 'ZackWord');
    await runAs(OTHER, 'claim', 'ZackOther');

    const mine = await runAs(PLAYER, 'hintpings', 'ZackWord', 'channel');
    assert.ok(!gated(mine), said(mine));
    assert.strictEqual(claims.hintPingMode(claims.find(watch.id, 'ZackWord')), 'channel');

    const theirs = await runAs(PLAYER, 'hintpings', 'ZackOther', 'dm');
    assert.match(said(theirs), /claimed by <@444444444444444444> — only they or the bot owner can change it/);
    assert.strictEqual(claims.hintPingMode(claims.find(watch.id, 'ZackOther')), 'off');
});

test('watch, unwatch and catchup stay owner-only', async (t) => {
    asOwnedBot(t);
    const watch = await addWatch(['ZackWord']);

    const real = monitor.catchUp;
    let caughtUp = false;
    monitor.catchUp = async () => { caughtUp = true; return { ok: true, baseline: true }; };
    t.after(() => { monitor.catchUp = real; });

    for (const args of [['watch', 'localhost:38281', 'ZackWord'], ['unwatch', String(watch.id)], ['catchup']]) {
        const msg = await runAs(PLAYER, ...args);
        assert.ok(gated(msg), `${args[0]} answered a non-owner with: ${said(msg)}`);
    }
    assert.ok(monitor.getWatch(watch.id), 'the watch survived the unwatch attempt');
    assert.strictEqual(monitor.listWatches().length, 1, 'no watch was added');
    assert.strictEqual(caughtUp, false, 'no catch-up ran');

    const owner = await runAs(OWNER, 'catchup');
    assert.ok(!gated(owner), said(owner));
    assert.strictEqual(caughtUp, true, 'the owner still can');
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
