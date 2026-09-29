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
// thing to do and the ones cut are the ones with nothing to do.
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

// One slot's answer in the shape suggestNextAll gives it: `locations` earliest sphere first,
// `sphere` the lowest among them, `total` how many are listed and `open` how many are unchecked.
const inLogic = (slot, locations, open, sphere = 1) => ({
    ok: true, slot, mode: 'logic', locations, sphere: locations.length > 0 ? sphere : null, total: locations.length, open
});
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
    for (const name of slots) assert.ok(at(name) >= 0, `${name} is in the reply`);

    // Sphere 1, then the two sphere-3 slots by name, then nothing in logic, then nothing left.
    assert.ok(at('ZackEarly') < at('ZackBanner'), 'sphere 1 before sphere 3');
    assert.ok(at('ZackBanner') < at('ZackWord'), 'a tie in sphere goes by name');
    assert.ok(at('ZackWord') < at('ZackStuck'), 'something to do before nothing in logic yet');
    assert.ok(at('ZackStuck') < at('ZackDone'), 'nothing in logic yet before nothing left');
});

test('a slot answered from the seed\'s logic says how many are in logic and how many are still locked', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate_1', 'Door B'], 7, 2)));

    assert.strictEqual(reply.edits.length, 1, 'no loading line when the logic was already up');
    assert.ok(reply.final.startsWith('🧭 **What is in logic**\n'), reply.final);
    assert.ok(reply.final.includes('**ZackWord** — 2 in logic, 5 still locked\n• Crate\\_1\n• Door B\n'),
        `the count and every location, markdown escaped: ${reply.final}`);
    assert.ok(!reply.final.includes('Sphere 1 only'), reply.final);
});

// Past sphere 1 a flat list hides where one sphere ends. One slot has the room to head each group.
const spread = (slot, groups, open) => {
    const locations = groups.flatMap(([, names]) => names);
    return { ...inLogic(slot, locations, open, groups[0][0]), spheres: groups.flatMap(([s, names]) => names.map(() => s)) };
};

test('one slot whose list runs past sphere 1 is grouped under a heading per sphere', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(spread('ZackWord', [[1, ['Crate']], [2, ['Door B', 'Door C']]], 9)));
    assert.ok(reply.final.includes('**ZackWord** — 3 in logic, 6 still locked\n_Sphere 1_\n• Crate\n_Sphere 2_\n• Door B\n• Door C\n'),
        reply.final);
});

test('one slot whose list is all one sphere gets no heading', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(spread('ZackWord', [[2, ['Door B', 'Door C']]], 4)));
    assert.ok(reply.final.includes('still locked\n• Door B\n• Door C\n'), reply.final);
    assert.ok(!reply.final.includes('_Sphere'), reply.final);
});

test('sphere headings count against the 15-line cap and never end the list with nothing under them', async (t) => {
    await claimAll(['ZackWord']);
    const first = Array.from({ length: 13 }, (_, i) => `One ${i + 1}`);
    const reply = await askNext(t, answered(spread('ZackWord', [[1, first], [2, ['Two 1', 'Two 2']]], 40)));
    const block = reply.final.split('\n\n')[0].split('\n').slice(2);
    const lines = block.slice(0, block.findIndex(l => l.startsWith('• …')));
    assert.strictEqual(lines.length, 14, `the heading and 13 locations, with no room for a second heading: ${reply.final}`);
    assert.ok(!lines.includes('_Sphere 2_'), reply.final);
    assert.ok(reply.final.includes('• …2 more'), reply.final);
});

test('several slots are never grouped, so each keeps its four lines', async (t) => {
    await claimAll(['ZackWord', 'ZackBanner']);
    const reply = await askNext(t, answered(
        spread('ZackWord', [[1, ['Crate']], [2, ['Door B']]], 5),
        spread('ZackBanner', [[1, ['Flag']], [3, ['Tower']]], 5)));
    assert.ok(!reply.final.includes('_Sphere'), reply.final);
    assert.ok(reply.final.includes('• Crate\n• Door B'), reply.final);
});

test('a slot with everything unchecked in logic leaves the locked count out rather than saying 0', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate', 'Door'], 2)));

    assert.ok(reply.final.includes('**ZackWord** — 2 in logic\n• Crate\n• Door'), reply.final);
    assert.ok(!reply.final.includes('still locked'), reply.final);
});

test('a slot with nothing in logic yet says how much is still locked', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', [], 4)));

    assert.ok(reply.final.includes('**ZackWord** — nothing in logic yet; 4 still locked.'), reply.final);
    // Still an answer from the seed's own rules, just an empty one, so the lead stays.
    assert.ok(reply.final.includes(LEAD), reply.final);
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

    assert.ok(reply.final.includes('**ZackWord** — sphere 1 only: 2 open, 4 further in\n• Start Chest\n• Start Shop'),
        reply.final);
    assert.ok(reply.final.includes('**ZackBanner** — nothing open in sphere 1; 3 further in.'), reply.final);
    assert.ok(reply.final.includes(
        ' Sphere 1 only where the seed\'s own logic is unavailable ' +
        '(this seed was not generated here): it needs nothing, so it is always in logic._'), reply.final);
    assert.ok(!reply.final.includes(INSTALL), `the logic's detail reached the reply: ${reply.final}`);
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
    assert.ok(nothingLeft.final.endsWith('\n_Nothing here says what is in them._'), nothingLeft.final);
});

test('a first !ap next that has to wait for the seed\'s logic says so on its status line', async (t) => {
    await claimAll(['ZackWord']);
    const reply = await askNext(t, answered(inLogic('ZackWord', ['Crate'], 1)), { wait: true });

    assert.strictEqual(typeof reply.calls[0].options.onWait, 'function', 'the command hands suggestNextAll an onWait');
    assert.match(said(reply.msg), /Working out what is open across your 1 slot\(s\)/);
    assert.strictEqual(reply.edits.length, 2, 'the loading line, then the answer over it');
    assert.strictEqual(reply.edits[0], LOADING);
    assert.ok(reply.final.includes('**ZackWord** — 1 in logic\n• Crate'), reply.final);
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
