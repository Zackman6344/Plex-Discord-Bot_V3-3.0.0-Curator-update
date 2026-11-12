// commands/apmedia.js in front of the real helpers/apMediaGame.js, which trusts its caller: every
// permission check is the command's, so this file proves them against the game's own data.
//
// What has to hold: a self-link needs the !ap claim and lands in the room's spelling; a player
// reaches no slot but their own, typed by name or by key, while the owner reaches anyone's where the
// spec lets them; the list reads the real slot index (groups, the item that opens a locked title,
// the hint marker) and pages it; a manual check finds titles exactly, asks on a tie, suggests on a
// typo, asks about a title named only in part, reads a whole title ending "at 1600" as that title,
// and banks while the inventory is unknown; the Accept button grants exactly the account the
// owner linked, to that friend only, and a newer link or seven days turns an old button stale; the
// YAML reads the account of the person the list is for.
//
// Harness: the real command module through the slash()/prefix() fakes of test/bookCommand.test.js;
// the real game (createGame), never started, over the real apMediaStore in memory
// (createApMediaStore under the test runner with no env var) with
// test/fixtures/apmedia/slot_data_mixed.json, or a copy with The Matrix renamed, in its slot_data
// cache; a fake monitor with the archipelagoMonitor accessors the command and the game read; a fake
// PMS account list; a recording YAML builder; the real helpers/apMediaButtons.js pointed at the same
// game and a hand-set clock.

const test = require('node:test');
const assert = require('node:assert');

const config = require('../config/config.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const { createGame } = require('../helpers/apMediaGame.js');
const { createApMediaStore } = require('../helpers/apMediaStore.js');
const buttons = require('../helpers/apMediaButtons.js');
const apmedia = require('../commands/apmedia.js');
const FIXTURE = require('./fixtures/apmedia/slot_data_mixed.json');

const OWNER = '100000000000000009';
const ANA = '100000000000000001';
const BEN = '100000000000000002';
const G = '200000000000000001';
const CH = '400000000000000001';
const SEED = 'Seed_PLEX';
const T0 = 1791500000000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const EPHEMERAL = 64;
const MATRIX_WATCH = FIXTURE.entries.find((e) => e.t === 'The Matrix').w;

const saved = { apMediaEnabled: config.apMediaEnabled, archipelagoEnabled: config.archipelagoEnabled, ownerId: config.ownerId };
const restores = [];

test.beforeEach(() => {
	config.apMediaEnabled = true;
	config.archipelagoEnabled = true;
	config.ownerId = OWNER;
	buttons._lists.clear();
});
test.afterEach(() => {
	Object.assign(config, saved);
	while (restores.length) restores.pop()();
	buttons._lists.clear();
});

function person(id, name) {
	const sent = [];
	return { id, username: name, sent, async send(p) { sent.push(p); return {}; } };
}

function reply(p) {
	return { payload: p, async edit() { return this; } };
}

function slashCall(who, sub, values = {}) {
	const calls = [];
	const interaction = {
		calls,
		commandName: 'apmedia',
		user: who,
		member: { id: who.id, user: who },
		guild: { id: G },
		guildId: G,
		client: {},
		channel: { id: CH, name: 'media', async send(p) { calls.push(['channel.send', p]); return reply(p); } },
		options: {
			data: [],
			getSubcommand: () => sub,
			get: (name) => (values[name] === undefined || (values[name] && values[name].id) ? null : { name, value: values[name] }),
			getUser: (name) => (values[name] && values[name].id ? values[name] : null)
		},
		async editReply(p) { calls.push(['editReply', p]); return reply(p); },
		async followUp(p) { calls.push(['followUp', p]); return reply(p); }
	};
	const query = slashRegistry.buildQueryString(interaction, apmedia.command.slash);
	return { interaction, query, message: adaptInteraction(interaction, query) };
}

async function slash(who, sub, values) {
	const s = slashCall(who, sub, values);
	await apmedia.command.process({ config: { commandPrefix: '!' } }, null, s.message, s.query);
	const hit = s.interaction.calls.find((c) => c[0] === 'editReply');
	assert.ok(hit, `a reply to ${sub}`);
	return hit[1];
}

async function prefix(who, query) {
	const calls = [];
	const message = {
		author: who,
		member: { id: who.id, user: who },
		guild: { id: G },
		content: `!apmedia ${query}`,
		mentions: { users: { first: () => undefined, get: () => undefined } },
		channel: { id: CH, name: 'media', async send(p) { calls.push(['send', p]); return reply(p); }, async sendTyping() {} },
		async reply(p) { calls.push(['reply', p]); return reply(p); }
	};
	await apmedia.command.process({ config: { commandPrefix: '!' } }, null, message, query);
	return calls[0][1];
}

function quietLogger() {
	const lines = [];
	const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
	return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function fakeMonitor() {
	const mon = {
		claims: [],
		hints: [],
		room: { ZackPlex: 'Plex Media', BenPlex: 'Plex Media', Watcher: 'ChecksFinder' },
		getWatch: (id) => (Number(id) === 0 ? { id: 0, channelId: CH, password: null, target: { host: 'localhost', port: 38281 } } : null),
		describeSlot(watchId, name) {
			if (Number(watchId) !== 0) return null;
			const names = Object.keys(mon.room);
			const canonical = names.find((n) => n.toLowerCase() === String(name).trim().toLowerCase()) || null;
			return { known: true, canonical, slotId: canonical ? names.indexOf(canonical) + 1 : null, game: canonical ? mon.room[canonical] : null };
		},
		onWatchChange: () => () => {},
		listHints: (id) => (Number(id) === 0 ? mon.hints : null),
		listClaims: (id) => (Number(id) === 0 ? mon.claims.map((c) => ({ watchId: 0, pings: 'progression', ...c })) : null)
	};
	return mon;
}

function recordingBuilder() {
	const calls = [];
	return {
		calls,
		async build(params) {
			calls.push(params);
			return { yaml: 'name: "x"\n', fileName: 'x.yaml', summary: { counts: { movie: 1 }, entries: 1, locations: 2, hours: 2, startOpen: 1, goalCount: 1, hoursToGoal: 2, warnings: [], misses: [] } };
		},
		cachedPlaylists: () => [],
		async playlists() { return []; }
	};
}

function setup() {
	const h = { clock: T0, monitor: fakeMonitor(), logger: quietLogger(), builder: recordingBuilder() };
	h.store = createApMediaStore({ now: () => h.clock });
	h.pms = { async accounts() { return [{ id: 1, name: 'Owner' }, { id: 7, name: 'Friend' }, { id: 8, name: 'Other' }]; } };
	h.game = createGame({ store: h.store, monitor: h.monitor, config, pms: h.pms, logger: h.logger, commandLog: { recordEvent() {} }, now: () => h.clock });
	restores.push(apmedia._internal.use({ game: h.game, monitor: h.monitor, builder: h.builder }));
	restores.push(buttons._use({ game: h.game, now: () => h.clock }));
	return h;
}

/** A binding as the game makes it, with the fixture's list (or another) in its slot_data cache. */
function bind(h, slot, userId, { seed = true, slotData = FIXTURE } = {}) {
	const b = h.store.bindings.put({ watchId: 0, slot, userId, boundBy: OWNER });
	if (seed) {
		h.store.cache.write(SEED, slot, JSON.parse(JSON.stringify(slotData)));
		h.store.bindings.patch(b.key, { seedName: SEED });
	}
	return b.key;
}

test('a player links the slot they claimed, in the room\'s spelling; a slot claimed by nobody, or by someone else, stays put', async () => {
	const h = setup();
	h.monitor.claims.push({ slot: 'ZackPlex', userId: ANA }, { slot: 'BenPlex', userId: BEN }, { slot: 'Watcher', userId: BEN });
	const ok = await slash(person(ANA, 'Ana'), 'link', { slot: 'zackplex' });
	assert.match(ok.content, /^\u{1F517} Linked `ZackPlex` on watch #0\./u);
	assert.match(ok.content, /\u26A0\uFE0F No Plex account is linked for them, so only Discord listening counts/);
	const stored = h.store.bindings.list();
	assert.deepStrictEqual(stored.map((b) => [b.slot, b.userId, b.boundBy]), [['ZackPlex', ANA, ANA]]);
	const theirs = await slash(person(ANA, 'Ana'), 'link', { slot: 'BenPlex' });
	assert.match(theirs.content, /Claim the slot first: `!ap claim BenPlex`/);
	const game = await slash(person(BEN, 'Ben'), 'link', { slot: 'watcher' });
	assert.match(game.content, /`Watcher` plays ChecksFinder in that room, not Plex Media\./);
	const taken = await slash(person(OWNER, 'Owner'), 'link', { slot: 'ZackPlex', user: person(BEN, 'Ben') });
	assert.match(taken.content, /is linked to someone else already/);
	assert.strictEqual(h.store.bindings.list().length, 1);
});

test('a player reaches no slot but their own, by name or by key; the owner reaches anyone\'s', async () => {
	const h = setup();
	const zack = bind(h, 'ZackPlex', ANA);
	bind(h, 'BenPlex', BEN, { seed: false });
	const ben = person(BEN, 'Ben');
	for (const [sub, values] of [
		['list', { slot: 'ZackPlex' }], ['list', { slot: zack }], ['status', { slot: zack }], ['retry', { slot: zack }],
		['unlink', { slot: zack }], ['check', { title: 'The Matrix', slot: zack }], ['redeem', { title: '1917', slot: zack }],
		['announce', { mode: 'off', slot: zack }]
	]) {
		const r = await slash(ben, sub, values);
		assert.match(r.content, /No linked Plex Media slot is called/, `${sub} ${JSON.stringify(values)}`);
	}
	assert.strictEqual(h.store.bindings.get(zack).announce, true);
	assert.deepStrictEqual(h.store.bindings.get(zack).banked, []);
	assert.ok(h.store.bindings.get(zack), 'still linked');
	const boss = person(OWNER, 'Owner');
	assert.match((await slash(boss, 'list', { slot: zack })).content, /^`ZackPlex`: 3 ready, 16 locked, 0 done of 19/);
	assert.match((await slash(boss, 'announce', { mode: 'off', slot: zack })).content, /No linked Plex Media slot is called/, 'announce is the player\'s own');
	assert.match((await prefix(boss, 'unlink BenPlex')).content, /^Unlinked `BenPlex`\./);
	assert.strictEqual(h.store.bindings.list().length, 1);
});

test('list reads the slot index: groups, what opens a locked title, the hint marker, all of it on pages that fit', async () => {
	const h = setup();
	bind(h, 'ZackPlex', ANA);
	h.monitor.hints.push({ finder: 'ZackPlex', receiver: 'Watcher', item: 'Key', where: 'Watch The Matrix (1999)', location: MATRIX_WATCH });
	const ana = person(ANA, 'Ana');
	const ready = await slash(ana, 'list', {});
	assert.match(ready.content, /\*\*Ready to watch or hear now:\*\*/);
	assert.match(ready.content, /\*\*Movies\*\* \(0 of 6 done\)\n\u2022 The Matrix \(1999\) \u00B7 2h16m \u00B7 \u{1F4A1} hinted for `Watcher`\n/u);
	assert.strictEqual(ready.content.split('Halloween (2018) \u00B7').length - 1, 2);
	const s = slashCall(ana, 'list', { show: 'locked' });
	await apmedia.command.process({ config: { commandPrefix: '!' } }, null, s.message, s.query);
	const first = s.interaction.calls.find((c) => c[0] === 'editReply')[1];
	let pages = [first.content];
	if (first.components && first.components.length) {
		const next = first.components[0].toJSON().components[1].custom_id;
		pages = buttons._lists.get(/^apmedia:page:([^:]+):/.exec(next)[1]).pages;
	}
	const all = pages.join('\n');
	assert.ok(pages.every((p) => p.length <= 2000));
	for (const heading of ['Movies', 'Breaking Point', 'Tiny Show', 'Albums', 'Road Trip', 'Books']) assert.ok(all.includes(`**${heading}**`), heading);
	assert.match(all, /\u2022 S01E03 \u00B7 45m \u00B7 opened by Breaking Point: Next 3 Episodes \(the 2nd\)/);
	assert.match(all, /\u2022 S01E01 \u00B7 45m \u00B7 opened by Breaking Point: Next 3 Episodes\n/);
	assert.match(all, /\u2022 1917 \u00B7 1h59m \u00B7 opened by 1917 \(movie\)/);
	assert.ok(!/The Matrix/.test(all), 'a ready title is not in the locked view');
});

test('check finds the title exactly, asks on a tie, suggests on a typo, and banks while the items are unknown', async () => {
	const h = setup();
	const key = bind(h, 'ZackPlex', ANA);
	const ana = person(ANA, 'Ana');
	const timed = await prefix(ana, 'check The Matrix at 45m');
	assert.strictEqual(timed.content, '\u{1F512} **The Matrix (1999)**: 3 checks held until the room reports `ZackPlex`\'s items.');
	assert.strictEqual(h.store.bindings.get(key).banked.length, 3);
	const tie = await slash(ana, 'check', { title: 'Halloween' });
	assert.strictEqual(tie.content, 'Several titles match: **Halloween (2018)** `movie|rk:2002`, **Halloween (2018)** `movie|rk:2003`. Give the one you mean by the code after it.');
	const picked = await prefix(ana, 'check movie|rk:2003');
	assert.match(picked.content, /\*\*Halloween \(2018\)\*\*: \d+ checks held/, 'the code names one copy');
	const bankedAfterTie = h.store.bindings.get(key).banked.length;
	assert.ok(bankedAfterTie > 3);
	const typo = await slash(ana, 'check', { title: 'the matirx' });
	assert.strictEqual(typo.content, 'Nothing on `ZackPlex`\'s list matches **the matirx**. Did you mean **The Matrix (1999)**?');
	const whole = await slash(ana, 'check', { title: 'The Matrix' });
	assert.match(whole.content, /6 checks held until the room reports/, 'the rest of the title, once');
	assert.strictEqual(h.store.bindings.get(key).banked.length, bankedAfterTie + 6);
	assert.strictEqual(h.store.bindings.get(key).pending.length, 0);
});

/** The fixture with The Matrix renamed, so a title can be set up that the fixture lacks. */
function renamed(t, y) {
	const slotData = JSON.parse(JSON.stringify(FIXTURE));
	const entry = slotData.entries.find((e) => e.t === 'The Matrix');
	Object.assign(entry, { t, y });
	return { slotData, entry };
}

// The bug: the game takes any part of a title, so "Alien" sent the checks of Aliens (1986), "Pop"
// those of Popcorn, and "Prid" spent a Wild Ticket on Pride and Prejudice; none can be taken back.
test('a title named in part is asked about and nothing counts; named in full, or without its article or year, it does', async () => {
	const h = setup();
	const { slotData } = renamed('Aliens', 1986);
	const key = bind(h, 'ZackPlex', ANA, { slotData });
	const ana = person(ANA, 'Ana');
	const banked = () => h.store.bindings.get(key).banked.length;
	assert.strictEqual((await prefix(ana, 'check Alien')).content, 'Did you mean **Aliens (1986)**? Type its title in full, or give its code: `movie|plex://movie/5d7768b2`.');
	assert.strictEqual((await prefix(ana, 'check Pop at 10m')).content, 'Did you mean **Popcorn**? Type its title in full, or give its code: `movie|rk:2005`.');
	assert.strictEqual((await slash(ana, 'redeem', { title: 'Prid' })).content, 'Did you mean **Pride and Prejudice by Jane Austen**? Type its title in full, or give its code: `book|book:jane-austen/pride-and-prejudice`.');
	assert.strictEqual(banked(), 0, 'nothing counted on a guess');
	assert.strictEqual(h.store.bindings.get(key).wildUsed, 0);
	assert.match((await prefix(ana, 'check aliens 1986')).content, /^\u{1F512} \*\*Aliens \(1986\)\*\*: 9 checks held until the room reports/u);
	const afterAliens = banked();
	assert.match((await slash(ana, 'check', { title: 'hobbit' })).content, /^\u{1F512} \*\*The Hobbit by J\. R\. R\. Tolkien\*\*: \d+ checks? held/u);
	assert.ok(banked() > afterAliens, 'a book named without its article or author counts');
	assert.match((await prefix(ana, 'check movie|plex://movie/5d7768b2')).content, /Nothing new/, 'its code names it too');
});

// The bug: "check Murder at 1600" was read as "Murder", 1,600 minutes in, and credited the
// checkpoints of a span instead of the film.
test('a list title that ends in "at" and a number is that title, not a time into another', async () => {
	const h = setup();
	const { slotData, entry } = renamed('Murder at 1600', 1997);
	const key = bind(h, 'ZackPlex', ANA, { slotData });
	const reply = await prefix(person(ANA, 'Ana'), 'check Murder at 1600');
	assert.strictEqual(reply.content, `\u{1F512} **Murder at 1600 (1997)**: ${entry.cp.length + 1} checks held until the room reports \`ZackPlex\`'s items.`);
	const banked = new Set(h.store.bindings.get(key).banked);
	assert.ok(banked.has(entry.w), 'its watch location: the whole film');
	assert.ok(entry.cp.every(([, id]) => banked.has(id)));
	const timed = await prefix(person(ANA, 'Ana'), 'check Murder at 1600 at 20m');
	assert.match(timed.content, /Nothing new/, 'a time after the title still reads as one');
});

test('status, redeem and announce speak for the player\'s own slot', async () => {
	const h = setup();
	const key = bind(h, 'ZackPlex', ANA);
	const ana = person(ANA, 'Ana');
	const status = await slash(ana, 'status', {});
	assert.match(status.content, /^1 Plex Media slot\. Plex Media is not running yet/);
	assert.match(status.content, /`ZackPlex` on watch #0: off/);
	assert.match(status.content, /> 0 of 19 done, goal: finish 15\. 3 ready, 16 locked \(as at the start/);
	assert.match(status.content, /> Plex account: none, so only Discord listening counts/);
	assert.match((await slash(ana, 'redeem', { title: '1917' })).content, /has not reported its items yet, so its Wild Tickets are not known/);
	assert.strictEqual((await slash(ana, 'announce', { mode: 'off' })).content, 'Announcements for `ZackPlex` are off.');
	assert.strictEqual(h.store.bindings.get(key).announce, false);
	assert.strictEqual((await prefix(ana, 'announce maybe')).content, 'Say `on` or `off`.');
	assert.strictEqual(h.store.bindings.get(key).announce, false);
});

test('the Accept button grants the account the owner linked, to that friend only, until a newer link or seven days', async () => {
	const h = setup();
	const owner = person(OWNER, 'Owner');
	const ana = person(ANA, 'Ana');
	const r = await slash(owner, 'account', { user: ana, plex: 'Friend' });
	assert.match(r.content, /<@100000000000000001>: Linked to Plex account `Friend` \(account 7\), waiting for their consent/);
	assert.match(r.content, /They have a DM with an Accept button/);
	assert.strictEqual(h.game.accountOf(ANA).consent, 'pending');
	const customId = ana.sent[0].components[0].toJSON().components[0].custom_id;
	assert.strictEqual(customId, `apmedia:consent:${ANA}.${T0.toString(36)}`);

	const click = (userId, id = customId) => {
		const calls = [];
		return {
			calls,
			customId: id,
			user: { id: userId },
			message: { content: ana.sent[0].content },
			async reply(p) { calls.push(['reply', p]); },
			async update(p) { calls.push(['update', p]); },
			async deferUpdate() { calls.push(['deferUpdate']); },
			async editReply(p) { calls.push(['editReply', p]); },
			async followUp(p) { calls.push(['followUp', p]); }
		};
	};
	const intruder = click(BEN);
	assert.strictEqual(await buttons.handle(intruder, null, null, {}), true);
	assert.deepStrictEqual(intruder.calls.map((c) => [c[0], c[1].flags]), [['reply', EPHEMERAL]]);
	assert.strictEqual(h.game.accountOf(ANA).consent, 'pending');

	h.clock = T0 + 2 * DAY;
	const yes = click(ANA);
	await buttons.handle(yes, null, null, {});
	assert.deepStrictEqual(yes.calls.map((c) => c[0]), ['deferUpdate', 'editReply']);
	assert.match(yes.calls[1][1].content, /\u2705 Accepted: the Plex history of `Friend` \(account 7\) counts for your Plex Media slots\./);
	assert.deepStrictEqual(yes.calls[1][1].components, []);
	assert.strictEqual(h.game.accountOf(ANA).consent, 'granted');

	h.clock = T0 + 3 * DAY;
	await slash(owner, 'account', { user: ana, plex: '8' });
	assert.strictEqual(h.game.accountOf(ANA).consent, 'pending', 'another account asks again');
	const stale = click(ANA);
	await buttons.handle(stale, null, null, {});
	assert.match(stale.calls[0][1].content, /linked your Plex account again since this request/);
	assert.strictEqual(h.game.accountOf(ANA).consent, 'pending');
	const fresh = ana.sent[1].components[0].toJSON().components[0].custom_id;
	h.clock = T0 + 3 * DAY + 7 * DAY + 1;
	const late = click(ANA, fresh);
	await buttons.handle(late, null, null, {});
	assert.match(late.calls[0][1].content, /This request has expired/);
	assert.strictEqual(h.game.accountOf(ANA).consent, 'pending');
	assert.strictEqual(h.game.accountOf(ANA).accountId, 8);
});

// The bug: Bob could be linked to the Plex account Ana had accepted, and once he accepted, her
// watching counted, was announced and filtered his lists as his; and Ana could not take her consent
// back herself.
test('a Plex account linked to one friend goes to another only as shared, and a friend can withdraw their own link', async () => {
	const h = setup();
	const owner = person(OWNER, 'Owner');
	const ana = person(ANA, 'Ana');
	const ben = person(BEN, 'Ben');
	await slash(owner, 'account', { user: ana, plex: 'Friend' });
	await h.game.grantConsent(ANA);
	const refused = await slash(owner, 'account', { user: ben, plex: 'friend' });
	assert.strictEqual(refused.content, 'Plex account `Friend` (id 7) is already linked to <@100000000000000001>. Unlink it there first, or link it as shared if they use that account together. To link it anyway, add `shared:True`.');
	assert.strictEqual(h.game.accountOf(BEN), null);
	assert.strictEqual(ben.sent.length, 0, 'nobody asked');
	const shared = await slash(owner, 'account', { user: ben, plex: 'Friend', shared: true });
	assert.match(shared.content, /shared with <@100000000000000001>, waiting for their consent/);
	assert.match(ben.sent[0].content, /That account is also linked to <@100000000000000001>/);

	const withdrawn = await prefix(ana, 'account none');
	assert.strictEqual(withdrawn.content, 'Your Plex account link is gone: its history is no longer read for you.');
	assert.strictEqual(h.game.accountOf(ANA), null);
	assert.strictEqual(h.game.accountOf(BEN).accountId, 7, 'Ben\'s own link stays');
	assert.strictEqual((await slash(ana, 'account', { plex: 'none' })).content, 'No Plex account is linked for you.');
});

// Linked elsewhere, the owner left account 1 free to link to a friend without `shared`; the reply to
// the owner taking their own link back is where they learn they now read an account a friend holds.
test('the owner taking their own link back is told who else holds account 1', async () => {
	const h = setup();
	const owner = person(OWNER, 'Owner');
	const ana = person(ANA, 'Ana');
	await slash(owner, 'account', { user: owner, plex: 'Friend' });
	await slash(owner, 'account', { user: ana, plex: 'Owner' });
	await h.game.grantConsent(ANA);

	const told = 'Your Plex account link is gone: its history is no longer read for you. You are read as the server owner (account 1) again, which is also linked to <@100000000000000001>.';
	assert.strictEqual((await prefix(owner, 'account none')).content, told);
	await slash(owner, 'account', { user: owner, plex: 'Friend' });
	const viaSlash = await slash(owner, 'account', { plex: 'none' });
	assert.strictEqual(viaSlash.content, told);
	assert.deepStrictEqual(viaSlash.allowedMentions, { parse: [] }, 'naming Ana pings nobody');
});

test('the YAML reads the account of the person it is for, and only once they accepted', async () => {
	const h = setup();
	const owner = person(OWNER, 'Owner');
	const ana = person(ANA, 'Ana');
	const last = () => h.builder.calls[h.builder.calls.length - 1];
	await slash(owner, 'yaml', { name: 'Boss' });
	assert.deepStrictEqual([last().accountId, last().discordUserId], [1, OWNER], 'the owner, as the server owner');
	await slash(ana, 'yaml', { name: 'Ana' });
	assert.strictEqual(last().accountId, null);
	await slash(owner, 'account', { user: ana, plex: 'Friend' });
	await slash(ana, 'yaml', { name: 'Ana' });
	assert.strictEqual(last().accountId, null, 'linked, not yet accepted');
	await h.game.grantConsent(ANA);
	await slash(ana, 'yaml', { name: 'Ana' });
	assert.strictEqual(last().accountId, 7);
	await slash(owner, 'yaml', { name: 'Ana', for: ana });
	assert.deepStrictEqual([last().accountId, last().discordUserId], [7, ANA], 'for someone: their account, not the owner\'s');
	await slash(owner, 'yaml', { name: 'Ben', for: person(BEN, 'Ben') });
	assert.deepStrictEqual([last().accountId, last().discordUserId], [null, BEN]);
});
