// commands/apmedia.js: /apmedia and !apmedia, from what is typed to the game call and the reply.
//
// What has to hold: nothing runs while apMediaEnabled is off; the owner-only subcommands, and
// acting for somebody else, need a configured ownerId; every reply but the apworld's is private on
// slash, a second reply included (the adapter would post it publicly), and no reply pings or runs
// past 2,000 characters; the YAML options parse the same from `key="a value"` text and from slash
// options, the bot alone fills in the Plex account and Discord id, and nobody's list is filtered by
// somebody else's history; a check's time reads as 1h30m, @1h30m or 1:30:00, and a whole list title
// is never split at its "at"; a check or a Wild Ticket goes only to a title named in full; a
// self-link needs the !ap claim; the owner may name anybody's slot only where the spec lets them,
// and nobody may while ownerId is blank; the account list stays private; the Accept button reaches
// the friend by DM, or in the channel without a ping; a failure shows Plex's error code, never its
// host or the bot's folders; the installed apworld is read from the install dir's custom_worlds;
// autocomplete answers from memory and never waits on Plex.
//
// Harness: the real command module driven through slashRegistry.buildQueryString and
// interactionAdapter.adaptInteraction as app/music.js does (the slash()/prefix() fakes of
// test/bookCommand.test.js), with a recording stand-in for helpers/apMediaGame.js (its findEntry
// keeps the real one's order: a code, the whole title, a movie's title alone, then any part), the
// YAML builder and the apworld builder swapped in through the command's _internal.use; the real
// helpers/apMediaButtons.js; the real config module, its fields saved and restored; one test writes
// a real apworld under os.tmpdir() and removes it.

const test = require('node:test');
const assert = require('node:assert');

const config = require('../config/config.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const buttons = require('../helpers/apMediaButtons.js');
const yamlModule = require('../helpers/apMediaYaml.js');
const { PmsError } = require('../helpers/apMediaPlex.js');
const apmedia = require('../commands/apmedia.js');
const common = require('../commands/apmedia.js/common.js');

const OWNER = '100000000000000009';
const ANA = '100000000000000001';
const BEN = '100000000000000002';
const G = '200000000000000001';
const CH = '400000000000000001';
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };
const SUBS = apmedia._internal.SUBCOMMANDS.map((s) => s.name);

const saved = { apMediaEnabled: config.apMediaEnabled, archipelagoEnabled: config.archipelagoEnabled, ownerId: config.ownerId };
let restore = null;

test.beforeEach(() => {
	config.apMediaEnabled = true;
	config.archipelagoEnabled = true;
	config.ownerId = OWNER;
	buttons._lists.clear();
});
test.afterEach(() => {
	Object.assign(config, saved);
	if (restore) restore();
	restore = null;
	buttons._lists.clear();
});

// ---- fakes ------------------------------------------------------------------------------------

function person(id, name, { dm = true } = {}) {
	const sent = [];
	return {
		id,
		username: name,
		sent,
		async send(p) {
			if (!dm) throw new Error('Cannot send messages to this user');
			sent.push(p);
			return {};
		}
	};
}
const owner = () => person(OWNER, 'Owner');
const ana = (opts) => person(ANA, 'Ana', opts);
const ben = () => person(BEN, 'Ben');

function reply(p) {
	return { payload: p, async edit() { return this; } };
}

function prefixMessage(who, query, { mentions = [] } = {}) {
	const calls = [];
	return {
		calls,
		author: who,
		member: { id: who.id, user: who },
		guild: { id: G },
		content: `!apmedia ${query}`,
		mentions: { users: { first: () => mentions[0], get: (id) => mentions.find((u) => u.id === id) } },
		channel: { id: CH, name: 'media', async send(p) { calls.push(['send', p]); return reply(p); }, async sendTyping() { calls.push(['typing']); } },
		async reply(p) { calls.push(['reply', p]); return reply(p); }
	};
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

const BOT = { config: { commandPrefix: '!' } };

async function runPrefix(who, query, opts) {
	const m = prefixMessage(who, query, opts);
	await apmedia.command.process(BOT, null, m, query);
	return m.calls;
}

async function runSlash(who, sub, values) {
	const s = slashCall(who, sub, values);
	await apmedia.command.process(BOT, null, s.message, s.query);
	return s.interaction.calls;
}

function first(calls) {
	const hit = calls.find((c) => c[0] === 'reply' || c[0] === 'editReply');
	assert.ok(hit, `a reply: ${JSON.stringify(calls)}`);
	return typeof hit[1] === 'string' ? { content: hit[1] } : hit[1];
}

const label = (e) => `${e.t} (${e.y})`;

function stubGame(over = {}) {
	const calls = [];
	const game = {
		calls,
		accounts: new Map(),
		bindings: [],
		entries: [{ t: 'The Matrix', y: 1999 }, { t: 'Alien', y: 1979 }, { t: 'Breakfast at Tiffany\'s', y: 1961 }],
		lists: {},
		accountOf(userId) {
			calls.push(['accountOf', userId]);
			return game.accounts.get(String(userId)) || null;
		},
		resolveBinding(text, opts) {
			calls.push(['resolveBinding', text, opts]);
			const pool = game.bindings.filter((b) => opts.all === true || b.userId === String(opts.userId));
			const hits = pool.filter((b) => !text || b.key === text || b.slot.toLowerCase() === String(text).toLowerCase());
			if (hits.length === 1) return { ok: true, key: hits[0].key, binding: hits[0] };
			if (hits.length > 1) return { ok: false, message: 'Several slots match.', candidates: hits };
			return { ok: false, message: text ? `No linked Plex Media slot is called \`${text}\`.` : 'No Plex Media slot is linked to you.' };
		},
		// The real game's tiers: an entry key, the whole label, a movie's title alone, then any part of a label.
		findEntry(key, text) {
			calls.push(['findEntry', key, text]);
			const want = String(text).trim().toLowerCase();
			const found = (e) => ({ ok: true, entry: { k: 'movie', t: e.t, y: e.y }, entryKey: `movie|${label(e)}`, title: label(e) });
			const tiers = [(e) => `movie|${label(e)}` === String(text).trim(), (e) => label(e).toLowerCase() === want, (e) => e.t.toLowerCase() === want, (e) => label(e).toLowerCase().includes(want)];
			for (const tier of tiers) {
				const hits = game.entries.filter(tier);
				if (hits.length === 1) return found(hits[0]);
				if (hits.length > 1) return { ok: false, message: 'Several titles match.', candidates: hits.map(label) };
			}
			return { ok: false, message: `Nothing on the list matches **${text}**.` };
		},
		list(key, which) {
			calls.push(['list', key, which]);
			if (game.lists[which]) return game.lists[which];
			const rows = which === 'ready' ? game.entries.map((e) => ({ title: label(e), kind: 'movie', runtime: '2h', hinted: false, hintedFor: [] })) : [];
			return { ok: true, message: '`ZackPlex`: 3 ready.', which, groups: rows.length ? [{ name: 'Movies', kind: 'movie', done: 0, total: 3, rows }] : [] };
		},
		status(target) {
			calls.push(['status', target]);
			return { ok: true, message: 'No Plex Media slot is linked.', reason: null, bindings: [] };
		},
		async creditManual(key, ref, opts) { calls.push(['creditManual', key, ref, opts]); return { ok: true, message: `credited ${ref}` }; },
		async redeem(key, ref) { calls.push(['redeem', key, ref]); return { ok: true, message: `redeemed ${ref}` }; },
		async setAnnounce(key, on) { calls.push(['setAnnounce', key, on]); return { ok: true, message: `announce ${on}` }; },
		async link(args) { calls.push(['link', args]); return { ok: true, message: `Linked \`${args.slot}\` on watch #${args.watchId}.`, warnings: ['No Plex account is linked for them.'] }; },
		async unlink(key, by) { calls.push(['unlink', key, by]); return { ok: true, message: `Unlinked ${key}.` }; },
		async retry(key) { calls.push(['retry', key]); return { ok: true, message: `Reconnecting ${key}.` }; },
		async plexAccounts() { calls.push(['plexAccounts']); return [{ id: 1, name: 'Owner' }, { id: 7, name: 'Friend' }, { id: 8, name: 'Friendly' }]; },
		async linkAccount(userId, args) {
			calls.push(['linkAccount', userId, args]);
			const self = userId === OWNER;
			const account = { accountId: args.accountId, name: args.name, consent: self ? 'granted' : 'pending', implicit: false, linkedAt: 1791500000000, linkedBy: args.by };
			game.accounts.set(userId, account);
			return { ok: true, message: self ? 'Linked.' : 'Linked, waiting for their consent.', account, needsConsent: !self };
		},
		async unlinkAccount(userId) { calls.push(['unlinkAccount', userId]); return { ok: true, message: 'Unlinked their Plex account.' }; },
		slotNames(prefix, userId) { calls.push(['slotNames', prefix, userId]); return [{ name: 'ZackPlex', value: '0::zackplex' }]; },
		titles(key, prefix) { calls.push(['titles', key, prefix]); return Array.from({ length: 30 }, (_, i) => ({ name: `Title ${i}`, value: `movie|rk:${i}` })); }
	};
	return Object.assign(game, over);
}

function stubBuilder(over = {}) {
	const calls = [];
	return Object.assign({
		calls,
		summary: {
			counts: { movie: 2, episode: 0, album: 0, mix: 0, book: 0 }, shows: 0, entries: 2, locations: 20, copies: 2,
			startCopies: 1, wildTickets: 1, startOpen: 1, goalCount: 1, hours: 4, hoursToGoal: 2,
			warnings: ['Night *Shift* starts at its first episode'], misses: [{ query: 'Alein_', didYouMean: ['Alien'] }]
		},
		async build(params) {
			calls.push(['build', params]);
			return { yaml: 'name: "Zack"\nPlex Media:\n  goal_percent: 80\n', fileName: 'Zack.yaml', summary: this.summary };
		},
		cachedPlaylists(prefix) {
			calls.push(['cachedPlaylists', prefix]);
			return [{ rk: 501, title: 'Road Trip', type: 'audio', smart: false, items: 30 }, { rk: 502, title: 'x'.repeat(120), type: 'video', smart: true, items: 0 }];
		},
		async playlists() { throw new Error('autocomplete must not read Plex'); }
	}, over);
}

function use(over) {
	const parts = { game: stubGame(), builder: stubBuilder(), ...over };
	restore = apmedia._internal.use(parts);
	return parts;
}

// ---- gates ------------------------------------------------------------------------------------

test('with apMediaEnabled off every subcommand says so and touches nothing', async () => {
	const { game, builder } = use();
	config.apMediaEnabled = false;
	for (const sub of Object.keys(apmedia._internal.HANDLERS)) {
		const r = first(await runPrefix(owner(), `${sub} x`));
		assert.match(r.content, /Plex Media is turned off.*apMediaEnabled/, sub);
		assert.deepStrictEqual(r.allowedMentions, NO_PINGS);
	}
	assert.deepStrictEqual(game.calls, []);
	assert.deepStrictEqual(builder.calls, []);
});

test('account and apworld need a configured owner, and only the owner passes', async () => {
	const { game } = use({ apworld: { buildApworld() { throw new Error('must not build'); } } });
	config.ownerId = '';
	for (const sub of ['account', 'apworld']) {
		assert.match(first(await runPrefix(owner(), sub)).content, /no owner is set yet: set ownerId first/, sub);
	}
	config.ownerId = OWNER;
	assert.match(first(await runPrefix(ana(), 'account')).content, /^\u26D4 Only the bot owner can see and link Plex accounts\.$/);
	assert.match(first(await runPrefix(ana(), 'apworld')).content, /^\u26D4 Only the bot owner can hand out the apworld\.$/);
	assert.match(first(await runSlash(ana(), 'account', { user: ben(), plex: 'Friend' })).content, /Only the bot owner/);
	assert.deepStrictEqual(game.calls, []);
});

test('acting for somebody else needs the owner: a YAML for someone, a link for someone', async () => {
	const { game, builder } = use();
	assert.match(first(await runSlash(ana(), 'yaml', { name: 'Zack', for: ben() })).content, /Only the bot owner can build a list for someone else/);
	assert.match(first(await runPrefix(ana(), `yaml name=Zack for=<@${BEN}>`)).content, /Only the bot owner can build a list for someone else/);
	assert.match(first(await runSlash(ana(), 'link', { slot: 'BenPlex', user: ben() })).content, /Only the bot owner can link a slot for someone else/);
	assert.match(first(await runPrefix(ana(), `link BenPlex <@${BEN}>`)).content, /Only the bot owner can link a slot for someone else/);
	assert.deepStrictEqual(builder.calls, []);
	assert.ok(!game.calls.some((c) => c[0] === 'link'));
	config.ownerId = '';
	assert.match(first(await runSlash(owner(), 'yaml', { name: 'Zack', for: ben() })).content, /no owner is set yet/, 'strict: a blank ownerId lets nobody act for someone');
	assert.deepStrictEqual(builder.calls, []);
});

test('the owner may name anybody\'s slot for unlink, retry, status, list and check, never for redeem or announce', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::benplex', slot: 'BenPlex', userId: BEN, watchId: 0 });
	const allFor = (sub) => game.calls.filter((c) => c[0] === 'resolveBinding').map((c) => c[2].all);
	const cases = [
		['unlink', { slot: 'BenPlex' }],
		['retry', { slot: 'BenPlex' }],
		['status', { slot: 'BenPlex' }],
		['list', { slot: 'BenPlex' }],
		['check', { title: 'The Matrix', slot: 'BenPlex' }],
		['redeem', { title: 'The Matrix', slot: 'BenPlex' }],
		['announce', { mode: 'off', slot: 'BenPlex' }]
	];
	for (const [sub, values] of cases) {
		game.calls.length = 0;
		await runSlash(owner(), sub, values);
		assert.deepStrictEqual(allFor(sub), [!['redeem', 'announce'].includes(sub)], `${sub} by the owner`);
		game.calls.length = 0;
		const r = first(await runSlash(ana(), sub, values));
		assert.deepStrictEqual(allFor(sub), [false], `${sub} by a player`);
		assert.match(r.content, /No linked Plex Media slot is called `BenPlex`/, sub);
	}
	game.calls.length = 0;
	await runSlash(owner(), 'list', {});
	assert.deepStrictEqual(allFor('list'), [false], 'with no slot named, even the owner gets their own only one');
});

test('with ownerId blank nobody acts for somebody else: no other slot by name, no other user, no other slot offered', async () => {
	const { game } = use({ monitor: claimsMonitor([]) });
	game.bindings.push({ key: '0::benplex', slot: 'BenPlex', userId: BEN, watchId: 0 }, { key: '0::mine', slot: 'Mine', userId: OWNER, watchId: 0 });
	config.ownerId = '';
	const acted = () => game.calls.filter((c) => ['unlink', 'retry', 'status', 'list', 'creditManual', 'link'].includes(c[0]));
	for (const [sub, values] of [
		['unlink', { slot: 'BenPlex' }],
		['retry', { slot: 'BenPlex' }],
		['status', { slot: 'BenPlex' }],
		['list', { slot: 'BenPlex' }],
		['check', { title: 'The Matrix', slot: 'BenPlex' }]
	]) {
		game.calls.length = 0;
		const r = first(await runSlash(owner(), sub, values));
		assert.match(r.content, /No linked Plex Media slot is called `BenPlex`/, sub);
		assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'resolveBinding').map((c) => c[2].all), [false], sub);
		assert.deepStrictEqual(acted(), [], sub);
	}
	game.calls.length = 0;
	assert.match(first(await runSlash(ana(), 'status', { user: ben() })).content, /Only the bot owner can see someone else's slots, and no owner is set yet/);
	assert.match(first(await runSlash(owner(), 'link', { slot: 'BenPlex', user: ben() })).content, /Only the bot owner can link a slot for someone else, and no owner is set yet/);
	assert.match(first(await runPrefix(owner(), `link BenPlex <@${BEN}>`)).content, /no owner is set yet/);
	assert.deepStrictEqual(acted(), []);
	await runSlash(owner(), 'status', {});
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'status'), [['status', OWNER]], 'their own slots, not everybody\'s');
	game.calls.length = 0;
	await apmedia.command.slash.autocomplete(focus(owner(), 'list', 'slot', ''));
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'slotNames'), ['slotNames', '', OWNER], 'their own slots offered');
	const t = focus(owner(), 'check', 'title', 'mat', { slot: '0::benplex' });
	await apmedia.command.slash.autocomplete(t);
	assert.deepStrictEqual(t.responded, [[]], 'no titles of somebody else\'s slot');
	assert.ok(!game.calls.some((c) => c[0] === 'titles'));
});

// ---- replies ----------------------------------------------------------------------------------

test('every subcommand but apworld is private on slash', () => {
	const eph = apmedia.command.slash.ephemeral;
	for (const sub of SUBS) {
		assert.strictEqual(eph({ options: { getSubcommand: () => sub } }), sub !== 'apworld', sub);
	}
});

test('say: the first reply answers the defer, a second stays private on slash, nothing pings or runs long, nothing rejects', async () => {
	const s = slashCall(owner(), 'list', {});
	const say = apmedia._internal.makeSay(s.message, { ephemeral: true });
	await say('one');
	await say({ content: `two <@${ANA}> ${'x'.repeat(2100)}` });
	const calls = s.interaction.calls;
	assert.deepStrictEqual(calls.map((c) => c[0]), ['editReply', 'followUp']);
	assert.deepStrictEqual(calls[1][1].flags, EPHEMERAL);
	assert.deepStrictEqual(calls[1][1].allowedMentions, NO_PINGS);
	assert.ok(calls[1][1].content.length <= 2000);
	const pub = slashCall(owner(), 'apworld', {});
	const sayPublic = apmedia._internal.makeSay(pub.message, { ephemeral: false });
	await sayPublic('one');
	await sayPublic('two');
	assert.strictEqual(pub.interaction.calls[1][1].flags, undefined);
	const broken = apmedia._internal.makeSay({ async reply() { throw new Error('gone'); } });
	assert.strictEqual(await broken('x'), null);
	const m = prefixMessage(ana(), 'list');
	const sayPrefix = apmedia._internal.makeSay(m, { ephemeral: true });
	await sayPrefix('one');
	await sayPrefix('two');
	assert.deepStrictEqual(m.calls.map((c) => c[0]), ['reply', 'send']);
});

test('the bare command and ? show the sub-help, which fits an embed; an unknown word suggests the near one', async () => {
	use();
	for (const q of ['', '?', 'help']) {
		const m = prefixMessage(ana(), q);
		await apmedia.command.process(BOT, null, m, q);
		const embed = m.calls[0][1].embeds[0].data;
		assert.ok(embed.description.length <= 4096);
		assert.match(embed.description, /apmedia yaml name=You/);
	}
	assert.match(first(await runPrefix(ana(), 'staus')).content, /Unknown \/apmedia command "staus"\. Did you mean `!apmedia status`\?/);
	assert.match(first(await runPrefix(ana(), 'constructor')).content, /Unknown \/apmedia command/);
});

test('slot names reach a reply in a code span, titles escaped, and the reply never pings', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	game.lists.ready = {
		ok: true, message: '`Za\'ck`: 1 ready.', which: 'ready',
		groups: [{ name: 'Movies *x*', kind: 'movie', done: 0, total: 1, rows: [{ title: '_Hidden_ <@&123>', kind: 'movie', runtime: '1h', hinted: true, hintedFor: ['Bo`b'] }] }]
	};
	const r = first(await runSlash(ana(), 'list', {}));
	assert.match(r.content, /\*\*Movies \\\*x\\\*\*\*/);
	assert.match(r.content, /\\_Hidden\\_/);
	assert.match(r.content, /hinted for `Bo'b`/);
	assert.deepStrictEqual(r.allowedMentions, NO_PINGS);
});

// ---- yaml -------------------------------------------------------------------------------------

test('yaml from prefix text: key=value pairs, double or curly quotes, a bare name, the bot filling in account and id', async () => {
	const { builder, game } = use();
	game.accounts.set(ANA, { accountId: 7, name: 'Friend', consent: 'granted', implicit: false });
	await runPrefix(ana(), 'yaml name=Zack movies=10 titles="Alien; Aliens" unwatched=false time_movies=off goal-percent=70');
	assert.deepStrictEqual(builder.calls[0][1], {
		name: 'Zack', movies: '10', titles: 'Alien; Aliens', unwatched: 'false', timeMovies: 'off', goalPercent: '70', accountId: 7, discordUserId: ANA
	});
	await runPrefix(ana(), 'yaml Zack titles=\u201CBreakfast at Tiffany\'s; Heat\u201D');
	assert.deepStrictEqual(builder.calls[1][1], { name: 'Zack', titles: 'Breakfast at Tiffany\'s; Heat', accountId: 7, discordUserId: ANA });
	assert.strictEqual(typeof builder.calls[1][1].discordUserId, 'string');
});

test('yaml refuses what it cannot read before the builder runs', async () => {
	const { builder } = use();
	const said = async (q) => first(await runPrefix(ana(), q)).content;
	assert.match(await said('yaml name=Zack moovies=3'), /I do not know the option moovies\. The options are: name, preset/);
	assert.match(await said('yaml name=Zack accountId=1'), /filled in by the bot/);
	assert.match(await said('yaml name=Zack discord=1'), /filled in by the bot/);
	assert.match(await said('yaml name=Zack movies=3 movies=4'), /movies is given twice/);
	assert.match(await said('yaml Zack Plex movies=3'), /Write each option as key=value/);
	assert.match(await said('yaml movies=3'), /Give the list a slot name/);
	assert.match(await said('yaml name=Zack for=Ben'), /for= takes a mention/);
	assert.deepStrictEqual(builder.calls, []);
});

test('yaml from slash options: kebab-case names, numbers and booleans as Discord sends them, and more= for the rest', async () => {
	const { builder } = use();
	await runSlash(ana(), 'yaml', {
		name: 'Zack', preset: 'mixed', movies: 4, unwatched: false, 'max-episodes': 12, 'time-books': 0, 'tv-unlock': 'season',
		'episodes-per-unlock': 2, playlist: '501', more: 'label="Horror month" starting_unlocks=5 strict=true'
	});
	assert.deepStrictEqual(builder.calls[0][1], {
		name: 'Zack', preset: 'mixed', movies: 4, unwatched: false, maxEpisodes: 12, timeBooks: 0, tvUnlock: 'season', episodesPerUnlock: 2,
		playlist: '501', label: 'Horror month', startingUnlocks: '5', strict: 'true', accountId: null, discordUserId: ANA
	});
	assert.match(first(await runSlash(ana(), 'yaml', { name: 'Zack', more: 'name=Other' })).content, /do not know the option name/);
	assert.match(first(await runSlash(ana(), 'yaml', { name: 'Zack', movies: 3, more: 'movies=4' })).content, /movies is given twice/);
	assert.match(first(await runSlash(ana(), 'yaml', { name: 'Zack', more: `for=<@${BEN}>` })).content, /do not know the option for/);
	assert.strictEqual(builder.calls.length, 1);
	await runSlash(ana(), 'yaml', { name: 'Zack', more: 'checkpoint_items=anything locked_watches=ignore wild_tickets=0' });
	assert.deepStrictEqual(builder.calls[1][1], { name: 'Zack', checkpointItems: 'anything', lockedWatches: 'ignore', wildTickets: '0', accountId: null, discordUserId: ANA });
	const more = apmedia._internal.SUBCOMMANDS.find((s) => s.name === 'yaml').options.find((o) => o.name === 'more');
	for (const key of ['label', 'starting_unlocks', 'wild_tickets', 'strict', 'locked_watches', 'checkpoint_items']) assert.ok(more.description.includes(key), `the more option names ${key}`);
	assert.ok(more.description.length <= 100);
});

// The bug: a backtick in a slot name became a quote inside the suggested command, which then
// named another slot.
test('a command a reply suggests keeps a slot name or a typed name exact, backticks and all', async () => {
	use({ monitor: claimsMonitor([]) });
	const made = first(await runSlash(ana(), 'yaml', { name: 'Za`ck' }));
	assert.match(made.content, /claim the slot with ``!ap claim Za`ck``, then link it with ``\/apmedia link Za`ck``\./);
	const refused = first(await runSlash(ana(), 'link', { slot: 'Za`ck' }));
	assert.match(refused.content, /Claim the slot first: ``!ap claim Za`ck`` shows it is yours/);
	assert.strictEqual(first(await runPrefix(owner(), 'account Fr`iend')).content, 'Name who to link it to: ``!apmedia account @someone Fr`iend``.');
});

test('yaml reads only the account of the person the list is for, and only with their consent', async () => {
	const { builder, game } = use();
	const params = () => builder.calls[builder.calls.length - 1][1];
	await runSlash(ana(), 'yaml', { name: 'Zack' });
	assert.deepStrictEqual([params().accountId, params().discordUserId], [null, ANA], 'no account: none, so the builder asks for unwatched=false');
	game.accounts.set(ANA, { accountId: 7, consent: 'pending', implicit: false });
	await runSlash(ana(), 'yaml', { name: 'Zack' });
	assert.strictEqual(params().accountId, null, 'a link waiting for consent is not read');
	game.accounts.set(ANA, { accountId: 7, consent: 'granted', implicit: false });
	await runSlash(ana(), 'yaml', { name: 'Zack' });
	assert.strictEqual(params().accountId, 7);
	game.accounts.set(OWNER, { accountId: 1, consent: 'granted', implicit: true });
	await runSlash(owner(), 'yaml', { name: 'Boss' });
	assert.deepStrictEqual([params().accountId, params().discordUserId], [1, OWNER], 'the owner is the server owner\'s account');
	await runSlash(owner(), 'yaml', { name: 'Bennie', for: ben() });
	assert.deepStrictEqual([params().accountId, params().discordUserId], [null, BEN], 'never the owner\'s history for someone else');
	assert.ok(game.calls.some((c) => c[0] === 'accountOf' && c[1] === BEN));
});

test('yaml attaches the file and answers with the summary, escaped, and the next steps', async () => {
	const { builder } = use();
	const r = first(await runSlash(ana(), 'yaml', { name: 'Zack' }));
	assert.deepStrictEqual(r.files.map((f) => f.name), ['Zack.yaml']);
	assert.strictEqual(r.files[0].attachment.toString('utf8'), 'name: "Zack"\nPlex Media:\n  goal_percent: 80\n');
	assert.match(r.content, /^\u{1F4DD} `Zack`: your list, attached as `Zack\.yaml`\./u);
	assert.match(r.content, /2 entries \(2 movies\), 20 locations, about 4 h\./);
	assert.match(r.content, /goal: finish 1 of 2/);
	assert.match(r.content, /Night \\\*Shift\\\* starts/);
	assert.match(r.content, /Not found: Alein\\_ \(did you mean \*\*Alien\*\*\?\)/);
	assert.match(r.content, /send this file to the bot owner\. Once the seed is up, claim the slot with `!ap claim Zack`, then link it with `\/apmedia link Zack`\./);
	assert.match(r.content, /visible to the whole room and on the public tracker/);
	assert.deepStrictEqual(r.allowedMentions, NO_PINGS);
	const mine = first(await runSlash(owner(), 'yaml', { name: 'Bennie', for: ben() }));
	assert.match(mine.content, /a list for <@100000000000000002>/);
	assert.match(mine.content, /Players folder/);
	builder.build = async () => { throw new Error(yamlModule.ACCOUNT_FIX); };
	assert.strictEqual(first(await runSlash(ana(), 'yaml', { name: 'Zack' })).content, `\u274C ${yamlModule.ACCOUNT_FIX}`);
	assert.match(first(await runSlash(owner(), 'yaml', { name: 'Bennie', for: ben() })).content, /<@100000000000000002> has no Plex account linked with their consent/);
});

// The bug: anyone could start any number of builds at once, and each reads every listing of the
// library and the tracks or episodes of every pick: three at once made 857 Plex requests.
test('yaml builds one list per person at a time, and two at most at once', async () => {
	const { builder } = use();
	const gates = [];
	builder.build = (params) => new Promise((resolve, reject) => gates.push({ params, resolve, reject }));
	const done = (i) => gates[i].resolve({ yaml: 'name: "x"\n', fileName: 'x.yaml', summary: builder.summary });
	const anaFirst = runSlash(ana(), 'yaml', { name: 'Ana' });
	await waitTurns(() => gates.length === 1);
	const anaSecond = runSlash(ana(), 'yaml', { name: 'Ana2' });
	await turns(10);
	assert.strictEqual(gates.length, 1, 'a second build of one person never reaches the builder');
	assert.strictEqual(first(await anaSecond).content, '\u23F3 Your last list is still being built: wait for it, then ask again.');
	const benFirst = runSlash(ben(), 'yaml', { name: 'Ben' });
	await waitTurns(() => gates.length === 2);
	const third = runSlash(owner(), 'yaml', { name: 'Boss' });
	await turns(10);
	assert.strictEqual(gates.length, 2, 'nor a third build while two run');
	assert.strictEqual(first(await third).content, '\u23F3 2 lists are being built right now: try again in a minute.');

	done(0);
	assert.match(first(await anaFirst).content, /`Ana`: your list, attached/);
	gates[1].reject(new Error('years must look like 1990 or 1990-1999.'));
	assert.match(first(await benFirst).content, /years must look like/);
	const again = runSlash(ana(), 'yaml', { name: 'Ana' });
	await waitTurns(() => gates.length === 3);
	done(2);
	assert.match(first(await again).content, /attached/, 'a finished or failed build frees its place');
});

async function turns(n) {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function waitTurns(cond) {
	for (let i = 0; i < 50 && !cond(); i++) await turns(1);
	assert.ok(cond(), 'timed out');
}

// ---- apworld ----------------------------------------------------------------------------------

function fakeApworld(manifest) {
	const reads = [];
	return {
		reads,
		buildApworld: () => ({ buffer: Buffer.from('PK\u0005\u0006'), bytes: 62177, worldVersion: '0.1.0', files: [] }),
		readApworldManifest(file) {
			reads.push(file);
			if (manifest instanceof Error) throw manifest;
			return manifest;
		}
	};
}

test('apworld attaches the world and reads, never writes, the installed copy to compare versions', async () => {
	const said = async (apworld, installed = 'C:/AP/custom_worlds/plex_media.apworld') => {
		if (restore) restore();
		use({ apworld, installedApworld: installed });
		return first(await runPrefix(owner(), 'apworld'));
	};
	const same = await said(fakeApworld({ game: 'Plex Media', world_version: '0.1.0' }));
	assert.deepStrictEqual(same.files.map((f) => f.name), ['plex_media.apworld']);
	assert.match(same.content, /the Plex Media world 0\.1\.0 \(61 KB\)/);
	assert.match(same.content, /Install APWorld/);
	assert.match(same.content, /Keep it installed for as long as the seed's room lives: `!ap next` rebuilds the seed from it/);
	assert.match(same.content, /This PC already has world 0\.1\.0 installed\./);
	assert.match((await said(fakeApworld({ world_version: '0.0.9' }))).content, /This PC has world 0\.0\.9 installed, and this file is 0\.1\.0/);
	assert.match((await said(fakeApworld(null))).content, /has no archipelago\.json/);
	assert.match((await said(fakeApworld(new Error('C:/AP/plex_media.apworld is not a zip')))).content, /is not a valid zip: while it is there, every Archipelago program on this PC fails to start/);
	assert.match((await said(fakeApworld(Object.assign(new Error('missing'), { code: 'ENOENT' })))).content, /has no plex_media\.apworld installed yet/);
	const none = await said(fakeApworld({ world_version: '9.9.9' }), null);
	assert.ok(!/This PC/.test(none.content), 'no install configured: nothing compared');
	const bad = { buildApworld() { throw new Error('archipelago.json world_version must be exactly x.y.z'); }, readApworldManifest() { throw new Error('unused'); } };
	assert.strictEqual((await said(bad)).content, '\u274C The apworld could not be built; the bot log has the reason.');
});

// The bug: every test above handed the command its installed path, so the folder it really reads
// went untested, and a wrong one answers "no plex_media.apworld installed yet" with a broken copy there.
test('apworld reads <archipelagoInstallDir>/custom_worlds/plex_media.apworld, and nothing with no install set', async () => {
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const realBuild = require('../helpers/apworldBuild.js');
	const dir = path.join(os.tmpdir(), `plexbot-test-apmedia-install-${process.pid}`);
	const savedDir = config.archipelagoInstallDir;
	const reads = [];
	const apworld = { ...realBuild, readApworldManifest(file) { reads.push(file); return realBuild.readApworldManifest(file); } };
	try {
		const installed = realBuild.writeApworld(path.join(dir, 'custom_worlds', 'plex_media.apworld'));
		use({ apworld });
		config.archipelagoInstallDir = dir;
		const r = first(await runPrefix(owner(), 'apworld'));
		assert.deepStrictEqual(reads, [path.join(dir, 'custom_worlds', 'plex_media.apworld')]);
		assert.match(r.content, new RegExp(`This PC already has world ${installed.worldVersion.replace(/\./g, '\\.')} installed\\.`));
		reads.length = 0;
		config.archipelagoInstallDir = '  ';
		const none = first(await runPrefix(owner(), 'apworld'));
		assert.deepStrictEqual(reads, [], 'no install set: nothing read');
		assert.ok(!/This PC/.test(none.content));
		assert.deepStrictEqual(none.files.map((f) => f.name), ['plex_media.apworld']);
	} finally {
		config.archipelagoInstallDir = savedDir;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// The bug: a network error names the Plex host and port, the apworld's names the bot's folders,
// and the prefix replies, and the apworld's on slash too, are posted in the open channel.
test('a failed Plex read or apworld build shows its code, never the Plex host, port or a folder', async () => {
	const { game, builder } = use({
		apworld: { buildApworld() { throw new Error('ENOENT: no such file or directory, scandir \'C:\\Users\\someone\\bot\\apworld\\plex_media\''); }, readApworldManifest() { throw new Error('unused'); } }
	});
	const down = () => new PmsError('Plex at 192.0.2.20:32400 could not be reached for /library/sections: ECONNREFUSED.', { code: 'UNREACHABLE' });
	builder.build = async () => { throw down(); };
	game.plexAccounts = async () => { throw down(); };
	const posted = async (who, q, opts) => (await runPrefix(who, q, opts)).map((c) => (c[1] && c[1].content) || '').join('\n');
	const yaml = await posted(ana(), 'yaml name=Zack unwatched=false');
	assert.match(yaml, /^\u274C Plex could not be read \(UNREACHABLE\), so no list was built\. Try again in a while; the bot log has the details\.$/m);
	const list = await posted(owner(), 'account');
	assert.match(list, /Could not read the Plex server's accounts \(UNREACHABLE\)/);
	const friend = ana();
	const linking = await posted(owner(), `account <@${ANA}> Friend`, { mentions: [friend] });
	assert.match(linking, /Could not read the Plex server's accounts \(UNREACHABLE\)/);
	assert.strictEqual(friend.sent.length, 0);
	const world = await posted(owner(), 'apworld');
	assert.match(world, /The apworld could not be built; the bot log has the reason/);
	for (const text of [yaml, list, linking, world]) assert.doesNotMatch(text, /192\.0\.2|32400|ECONNREFUSED|scandir|Users|someone/);
	builder.build = async () => { throw new Error('years must look like 1990 or 1990-1999.'); };
	assert.match(await posted(ana(), 'yaml name=Zack years=nineties'), /^\u274C years must look like 1990 or 1990-1999\.$/m, 'the builder\'s own words still reach the player');
});

test('apworld with the real builder packs apworld/plex_media and spots a broken installed copy', async () => {
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const broken = path.join(os.tmpdir(), `plexbot-test-apmedia-command-${process.pid}.apworld`);
	fs.writeFileSync(broken, 'not a zip at all');
	try {
		use({ installedApworld: broken, apworld: undefined });
		const r = first(await runPrefix(owner(), 'apworld'));
		const zip = r.files[0].attachment;
		assert.strictEqual(zip.readUInt32LE(0), 0x04034b50, 'a zip');
		assert.ok(zip.includes(Buffer.from('plex_media/archipelago.json')));
		assert.match(r.content, /is not a valid zip/);
		assert.strictEqual(fs.readFileSync(broken, 'utf8'), 'not a zip at all', 'the installed copy is only read');
	} finally {
		fs.rmSync(broken, { force: true });
	}
});

// ---- account ----------------------------------------------------------------------------------

test('account with no one named lists the Plex accounts privately: an ephemeral reply, a DM on prefix', async () => {
	const { game } = use();
	const s = first(await runSlash(owner(), 'account', {}));
	assert.match(s.content, /`Friend`: id 7/);
	assert.match(s.content, /`Owner`: id 1, the server owner/);
	const o = owner();
	const calls = await runPrefix(o, 'account');
	assert.strictEqual(o.sent.length, 1);
	assert.match(o.sent[0].content, /`Friend`: id 7/);
	assert.deepStrictEqual(o.sent[0].allowedMentions, NO_PINGS);
	assert.match(first(calls).content, /Sent you the Plex account list by DM/);
	assert.ok(!JSON.stringify(calls).includes('Friend'), 'nothing of the list in the channel');
	const shut = person(OWNER, 'Owner', { dm: false });
	assert.match(first(await runPrefix(shut, 'account')).content, /could not DM you the account list: `\/apmedia account` shows it privately/);
	game.plexAccounts = async () => { throw new PmsError('Plex at localhost:32400 could not be reached for /accounts: TIMEOUT.', { code: 'TIMEOUT' }); };
	assert.strictEqual(first(await runSlash(owner(), 'account', {})).content, '\u274C Could not read the Plex server\'s accounts (TIMEOUT); the bot log has the details.');
	game.plexAccounts = async () => { throw new Error('boom'); };
	assert.strictEqual(first(await runSlash(owner(), 'account', {})).content, '\u274C Could not read the Plex server\'s accounts; the bot log has the details.');
});

test('account links a friend by name or id; the Accept button goes by DM, and closed DMs are asked to open, without the name', async () => {
	const { game } = use();
	const friend = ana();
	const r = first(await runSlash(owner(), 'account', { user: friend, plex: 'friend' }));
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'linkAccount'), ['linkAccount', ANA, { accountId: 7, name: 'Friend', by: OWNER, shared: false }]);
	assert.match(r.content, /They have a DM with an Accept button/);
	assert.strictEqual(friend.sent.length, 1);
	const dm = friend.sent[0];
	assert.match(dm.content, /linked you to the Plex account `Friend`/);
	assert.match(dm.content, /Nothing is read before you accept, and `\/apmedia account plex:none` takes it back at any time\./);
	const button = dm.components[0].toJSON().components[0];
	assert.strictEqual(button.custom_id, `apmedia:consent:${buttons.consentToken(ANA, 1791500000000)}`);
	assert.deepStrictEqual(dm.allowedMentions, NO_PINGS);

	// The bug: with the friend's DMs closed, the channel got the request and the Plex account's name,
	// while the account list itself goes only to the owner.
	const closed = ana({ dm: false });
	const s = slashCall(owner(), 'account', { user: closed, plex: '7' });
	await apmedia.command.process(BOT, null, s.message, s.query);
	const post = s.interaction.calls.find((c) => c[0] === 'channel.send');
	assert.ok(post, 'posted in the channel');
	assert.ok(post[1].content.startsWith(`<@${ANA}>: the bot owner linked you to a Plex account for Plex Media, and your DMs are closed to the bot.`), post[1].content);
	assert.ok(!post[1].content.includes('Friend'), 'no account name in the channel');
	assert.strictEqual(post[1].components, undefined, 'no button: the request comes by DM once they open them');
	assert.deepStrictEqual(post[1].allowedMentions, NO_PINGS);
	assert.match(first(s.interaction.calls).content, /this channel asks them to open them \(naming them without a ping\): link them again once they have/);
});

test('account: a prefix mention, a lookup, an ambiguous or unknown name, none, and the owner linking themselves', async () => {
	const { game } = use();
	const friend = ana();
	const r = first(await runPrefix(owner(), `account <@${ANA}> 7`, { mentions: [friend] }));
	assert.match(r.content, /They have a DM with an Accept button/);
	assert.strictEqual(friend.sent.length, 1);
	assert.match(first(await runPrefix(owner(), `account <@${ANA}>`, { mentions: [friend] })).content, /is linked to Plex account `Friend` \(id 7\), waiting for their consent/);
	assert.strictEqual(first(await runSlash(owner(), 'account', { user: ana(), plex: 'Fri' })).content, 'No Plex account is called `Fri`. Did you mean one of `Friend` (id 7), `Friendly` (id 8)? Give the full name or the id.');
	assert.match(first(await runSlash(owner(), 'account', { user: ana(), plex: 'Nobody' })).content, /No Plex account is called `Nobody`/);
	assert.match(first(await runSlash(owner(), 'account', { user: ana(), plex: '99' })).content, /No Plex account on this server has id 99/);
	assert.match(first(await runSlash(owner(), 'account', { user: ana(), plex: 'none' })).content, /Unlinked their Plex account/);
	assert.ok(game.calls.some((c) => c[0] === 'unlinkAccount' && c[1] === ANA));
	const me = owner();
	const self = first(await runSlash(owner(), 'account', { user: me, plex: 'Owner' }));
	assert.ok(!/Accept/.test(self.content), 'the owner linking themselves is granted at once');
	assert.strictEqual(me.sent.length, 0);
	const warn = first(await runSlash(owner(), 'account', { user: ben(), plex: '1' }));
	assert.match(warn.content, /Account 1 is the server owner's own account/);
	const listed = await game.plexAccounts();
	game.plexAccounts = async () => [...listed, { id: 9, name: '2024' }];
	await runSlash(owner(), 'account', { user: ben(), plex: '2024' });
	assert.strictEqual(game.calls.filter((c) => c[0] === 'linkAccount').pop()[2].accountId, 9, 'a user name of digits, when no account has that id');
	assert.strictEqual(first(await runPrefix(owner(), 'account Friend')).content, 'Name who to link it to: `!apmedia account @someone Friend`.');
});

// The bug: one prefix or substring hit was taken as the account, so "al" linked Bob to alice and her
// whole history counted for him once he accepted. A link now takes a full name or an id only.
test('account: part of a name is a question, sent by DM on the prefix path, and links nobody', async () => {
	const { game } = use();
	game.plexAccounts = async () => [{ id: 1, name: 'Owner' }, { id: 5, name: 'alice' }, { id: 6, name: 'bob' }];
	const one = first(await runSlash(owner(), 'account', { user: ben(), plex: 'al' }));
	assert.strictEqual(one.content, 'No Plex account is called `al`. Did you mean `alice` (id 5)? Give its full name or its id.');
	assert.match(first(await runSlash(owner(), 'account', { user: ben(), plex: 'lic' })).content, /Did you mean `alice` \(id 5\)\?/, 'a part inside the name too');
	assert.ok(!game.calls.some((c) => c[0] === 'linkAccount'), 'nothing linked');

	const o = owner();
	const calls = await runPrefix(o, `account <@${BEN}> al`, { mentions: [ben()] });
	assert.strictEqual(first(calls).content, '\u{1F4EC} Sent you the Plex accounts that match by DM.');
	assert.ok(!JSON.stringify(calls).includes('alice'), 'no account name in the channel');
	assert.match(o.sent[0].content, /Did you mean `alice` \(id 5\)\?/);
	assert.match(first(await runSlash(owner(), 'account', { user: ben(), plex: 'ALICE' })).content, /Linked/, 'the full name, in any case');
	assert.strictEqual(game.calls.find((c) => c[0] === 'linkAccount')[2].accountId, 5);
});

test('account: an account somebody else holds is linked only with shared, said in the consent request', async () => {
	const { game } = use();
	const linked = [];
	game.linkAccount = async (userId, args) => {
		linked.push(args);
		if (!args.shared) return { ok: false, message: 'Plex account `Friend` (id 7) is already linked to <@100000000000000002>. Unlink it there first, or link it as shared if they use that account together.', heldBy: [BEN] };
		const account = { accountId: 7, name: 'Friend', consent: 'pending', implicit: false, linkedAt: 1791500000000 };
		return { ok: true, message: 'Linked to Plex account `Friend` (account 7), shared with <@100000000000000002>, waiting for their consent: nothing is read until they accept.', account, needsConsent: true, sharedWith: [BEN] };
	};
	const friend = ana();
	assert.match(first(await runSlash(owner(), 'account', { user: friend, plex: 'Friend' })).content, /already linked to <@100000000000000002>\. .* To link it anyway, add `shared:True`\.$/);
	assert.match(first(await runPrefix(owner(), `account <@${ANA}> Friend`, { mentions: [friend] })).content, /To link it anyway, add `shared=yes`\.$/);
	assert.strictEqual(friend.sent.length, 0, 'nothing asked');

	const s = slashCall(owner(), 'account', { user: friend, plex: 'Friend', shared: true });
	assert.match(s.query, /shared=yes/, 'the command log reads like the prefix form');
	await apmedia.command.process(BOT, null, s.message, s.query);
	assert.strictEqual(linked.at(-1).shared, true);
	assert.match(friend.sent[0].content, /That account is also linked to <@100000000000000002>: what any of you watches on it counts for all of you\./);
	await runPrefix(owner(), `account <@${ANA}> Friend shared=yes`, { mentions: [friend] });
	assert.deepStrictEqual(linked.at(-1), { accountId: 7, name: 'Friend', by: OWNER, shared: true });
	assert.strictEqual(first(await runPrefix(owner(), `account <@${ANA}> Friend shared=maybe`, { mentions: [friend] })).content, 'shared= takes yes or no.');
});

// The bug: a friend who accepted could not take it back: every form of /apmedia account was the
// owner's, and the next slot they linked was read again without asking.
test('account none withdraws the caller\'s own link, owner or not; anyone else\'s stays the owner\'s', async () => {
	const { game } = use();
	const mine = first(await runPrefix(ana(), 'account none'));
	assert.strictEqual(mine.content, 'Your Plex account link is gone: its history is no longer read for you.');
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'unlinkAccount'), [['unlinkAccount', ANA]]);
	assert.match(first(await runSlash(ana(), 'account', { plex: 'none' })).content, /^Your Plex account link is gone/);
	assert.match(first(await runSlash(ana(), 'account', { user: ana(), plex: 'remove' })).content, /^Your Plex account link is gone/, 'naming themselves');
	assert.match(first(await runSlash(ana(), 'account', { user: ben(), plex: 'none' })).content, /^\u26D4 Only the bot owner/, 'not someone else\'s');
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'unlinkAccount').map((c) => c[1]), [ANA, ANA, ANA]);
	game.unlinkAccount = async () => ({ ok: false, message: 'No Plex account is linked for them.', account: null });
	assert.strictEqual(first(await runPrefix(ana(), 'account none')).content, 'No Plex account is linked for you.');
	config.ownerId = '';
	assert.strictEqual(first(await runPrefix(ana(), 'account none')).content, 'No Plex account is linked for you.', 'no owner set is no reason to keep a link');
});

// ---- link -------------------------------------------------------------------------------------

function claimsMonitor(claims) {
	return { listClaims: (id) => (Number(id) === 0 ? claims : null) };
}

test('a player links only a slot they hold the !ap claim on; the owner needs none', async () => {
	const { game } = use({ monitor: claimsMonitor([{ watchId: 0, slot: 'ZackPlex', userId: ANA }, { watchId: 0, slot: 'BenPlex', userId: BEN }]) });
	const refused = first(await runSlash(ana(), 'link', { slot: 'BenPlex' }));
	assert.match(refused.content, /Claim the slot first: `!ap claim BenPlex` shows it is yours/);
	assert.ok(!game.calls.some((c) => c[0] === 'link'));
	const ok = first(await runSlash(ana(), 'link', { slot: 'zackplex' }));
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'link')[1], { watchId: 0, slot: 'zackplex', userId: ANA, by: ANA });
	assert.match(ok.content, /Linked `zackplex` on watch #0\./);
	assert.match(ok.content, /\u26A0\uFE0F No Plex account is linked for them\./);
	game.calls.length = 0;
	await runPrefix(owner(), `link Some Slot <@${BEN}> watch=0`);
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'link')[1], { watchId: 0, slot: 'Some Slot', userId: BEN, by: OWNER });
	game.calls.length = 0;
	await runSlash(owner(), 'link', { slot: 'Unclaimed' });
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'link')[1].userId, OWNER);
	assert.match(first(await runSlash(ana(), 'link', { slot: 'ZackPlex', watch: 3 })).content, /There is no watch #3/);
	assert.match(first(await runPrefix(ana(), 'link ZackPlex watch=x')).content, /A watch id is a whole number/);
	assert.match(first(await runPrefix(ana(), 'link')).content, /Which slot\?/);
	config.archipelagoEnabled = false;
	assert.match(first(await runSlash(ana(), 'link', { slot: 'ZackPlex' })).content, /The Archipelago monitor is off/);
});

// ---- check, redeem, announce, unlink, retry -----------------------------------------------------

test('check reads the time as at 1h30m, @1h30m, at=45:00 or a slash option, and never mistakes a title for one', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	game.entries.push({ t: 'Murder at 1600', y: 1997 });
	const credited = () => game.calls.filter((c) => c[0] === 'creditManual').map((c) => [c[2], c[3].atMs]);
	await runPrefix(ana(), 'check The Matrix at 1h30m');
	await runPrefix(ana(), 'check The Matrix @1h30m');
	await runPrefix(ana(), 'check The Matrix @ 1:30:00');
	await runPrefix(ana(), 'check The Matrix at=45:00');
	await runPrefix(ana(), 'check Breakfast at Tiffany\'s');
	await runPrefix(ana(), 'check Breakfast at Tiffany\'s at 20m');
	await runPrefix(ana(), 'check The Matrix slot=Zack');
	await runSlash(ana(), 'check', { title: 'The Matrix', at: '@1h30m' });
	await runSlash(ana(), 'check', { title: 'The Matrix' });
	await runPrefix(ana(), 'check Murder at 1600');
	await runPrefix(ana(), 'check The Matrix at 90');
	assert.deepStrictEqual(credited(), [
		['movie|The Matrix (1999)', 5400000],
		['movie|The Matrix (1999)', 5400000],
		['movie|The Matrix (1999)', 5400000],
		['movie|The Matrix (1999)', 2700000],
		['movie|Breakfast at Tiffany\'s (1961)', null],
		['movie|Breakfast at Tiffany\'s (1961)', 1200000],
		['movie|The Matrix (1999)', null],
		['movie|The Matrix (1999)', 5400000],
		['movie|The Matrix (1999)', null],
		['movie|Murder at 1600 (1997)', null],
		['movie|The Matrix (1999)', 5400000]
	], 'a whole list title is never split at its "at"; a bare number after one that is not is minutes');
	game.calls.length = 0;
	assert.match(first(await runSlash(ana(), 'check', { title: 'The Matrix', at: 'soon' })).content, /could not read `soon` as a time into the title: write it like 45m, 1h30m or 1:30:00/);
	assert.match(first(await runSlash(ana(), 'check', { title: 'The Matrix', at: '0m' })).content, /could not read/);
	assert.deepStrictEqual(credited(), []);
});

test('a title that matches nothing is answered with the near misses and credited never', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	const r = first(await runSlash(ana(), 'check', { title: 'The Matirx' }));
	assert.match(r.content, /Nothing on the list matches \*\*The Matirx\*\*\. Did you mean \*\*The Matrix \(1999\)\*\*\?/);
	const none = first(await runSlash(ana(), 'redeem', { title: 'Zzzz' }));
	assert.strictEqual(none.content, 'Nothing on the list matches **Zzzz**.');
	assert.ok(!game.calls.some((c) => c[0] === 'creditManual' || c[0] === 'redeem'));
});

// The bug: a miss scored the whole typed text against every title with a full edit distance, on the
// main thread: 6,000 characters (the slash option's limit) against a 2,000-title list held the bot,
// and voice with it, for seconds per command.
test('a long text that matches nothing is not scored against the list', async (t) => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	game.entries = Array.from({ length: 300 }, (_, i) => ({ t: `Some Long Movie Title Number ${i}`, y: 2000 + (i % 20) }));
	game.entries.push({ t: 'The Matrix', y: 1999 });
	const bookSearch = require('../helpers/bookSearch.js');
	const damerau = bookSearch.damerau;
	let scored = 0;
	bookSearch.damerau = (a, b) => {
		scored += 1;
		return damerau(a, b);
	};
	t.after(() => { bookSearch.damerau = damerau; });

	const long = first(await runSlash(ana(), 'check', { title: 'some long movie title '.repeat(272) }));
	assert.match(long.content, /^Nothing on the list matches \*\*/);
	assert.strictEqual(scored, 0, 'no edit distance for a text no title is that long');
	const typo = first(await runSlash(ana(), 'check', { title: 'The Matirx' }));
	assert.match(typo.content, /Did you mean \*\*The Matrix \(1999\)\*\*\?/);
	assert.ok(scored > 0 && scored < 300 * 3, `a typo is still scored, mostly by length: ${scored} distances for 301 titles`);
});

test('a title is named in full by its code, or its title with or without the year, an article, an artist or an author', () => {
	const hit = (title, entry, entryKey = 'x|1') => ({ ok: true, entryKey, title, entry });
	const movie = hit('The Matrix (1999)', { k: 'movie', t: 'The Matrix', y: 1999 }, 'movie|rk:1');
	for (const typed of ['The Matrix (1999)', 'the matrix 1999', 'Matrix (1999)', 'The Matrix', 'matrix', '  MATRIX  ', 'movie|rk:1', '#4']) {
		assert.ok(common.namesInFull(typed, movie), typed);
	}
	for (const typed of ['Matri', 'The Matrix (199', 'Matrix Reloaded', 'the', '', 'movie|rk:2', '#x']) assert.ok(!common.namesInFull(typed, movie), typed);
	const album = hit('Daft Punk - Discovery', { k: 'album', t: 'Discovery', ar: 'Daft Punk' });
	assert.ok(common.namesInFull('Discovery', album) && common.namesInFull('daft punk discovery', album));
	const book = hit('The Hobbit by J. R. R. Tolkien', { k: 'book', t: 'The Hobbit' });
	assert.ok(common.namesInFull('Hobbit', book) && !common.namesInFull('Hobbit by', book));
	const pilot = hit('Pilot S01E01', { k: 'episode', t: 'Pilot', sh: 'Pilot' });
	assert.ok(common.namesInFull('pilot s01e01', pilot));
	assert.ok(!common.namesInFull('Pilot', pilot), 'an episode\'s own title names no episode in particular');
	assert.ok(common.namesInFull('An Unearthly Child', hit('An Unearthly Child', null)), 'the title alone, with no entry to read');
});

// The bug: the game takes any part of a title, so "Alien" on a list holding only Aliens (1986)
// sent Aliens' checks, and a Wild Ticket went on it; neither can be taken back.
test('a title typed only in part is asked about, never credited or redeemed on a guess', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	game.entries = [{ t: 'Aliens', y: 1986 }, { t: 'The Matrix', y: 1999 }, { t: 'The Hobbit', y: 2012 }];
	const asked = 'Did you mean **Aliens (1986)**? Type its title in full, or give its code: `movie|Aliens (1986)`.';
	assert.strictEqual(first(await runPrefix(ana(), 'check Alien')).content, asked);
	assert.strictEqual(first(await runPrefix(ana(), 'check Alien at 45m')).content, asked);
	assert.strictEqual(first(await runSlash(ana(), 'check', { title: 'Alien', at: '45m' })).content, asked);
	assert.strictEqual(first(await runSlash(ana(), 'redeem', { title: 'Alien' })).content, asked);
	assert.strictEqual(first(await runPrefix(ana(), 'redeem Hob')).content, 'Did you mean **The Hobbit (2012)**? Type its title in full, or give its code: `movie|The Hobbit (2012)`.');
	assert.ok(!game.calls.some((c) => c[0] === 'creditManual' || c[0] === 'redeem'));
	for (const typed of ['Aliens', 'aliens (1986)', 'movie|Aliens (1986)', 'Matrix', 'the matrix', 'Hobbit (2012)']) {
		game.calls.length = 0;
		await runPrefix(ana(), `check ${typed}`);
		assert.strictEqual(game.calls.filter((c) => c[0] === 'creditManual').length, 1, `${typed} names a title in full`);
	}
});

test('redeem, announce, unlink and retry pass the slot the caller means and show the game\'s answer', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 }, { key: '1::zack', slot: 'Zack 2', userId: ANA, watchId: 1 });
	assert.strictEqual(first(await runPrefix(ana(), 'redeem Alien slot="Zack 2"')).content, 'redeemed movie|Alien (1979)');
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'redeem'), ['redeem', '1::zack', 'movie|Alien (1979)']);
	assert.strictEqual(first(await runPrefix(ana(), 'announce off Zack')).content, 'announce off');
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'setAnnounce'), ['setAnnounce', '0::zack', 'off']);
	assert.strictEqual(first(await runSlash(ana(), 'unlink', { slot: '1::zack' })).content, 'Unlinked 1::zack.');
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'unlink'), ['unlink', '1::zack', ANA]);
	assert.match(first(await runPrefix(ana(), 'retry Zack')).content, /Reconnecting 0::zack\./);
	assert.match(first(await runPrefix(ana(), 'retry')).content, /Several slots match/);
	assert.match(first(await runPrefix(ana(), 'unlink')).content, /Which slot\?/);
	assert.match(first(await runPrefix(ana(), 'announce')).content, /On or off\?/);
	assert.match(first(await runPrefix(ben(), 'retry')).content, /No Plex Media slot is linked to you\. Once your seed is up, claim your slot with `!ap claim <slot>`, then `\/apmedia link <slot>`\./);
});

// ---- list and status pages --------------------------------------------------------------------

test('a long list is paged behind buttons only the asker can turn', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	const rows = Array.from({ length: 60 }, (_, i) => ({ title: `Show S01E${String(i + 1).padStart(2, '0')}`, kind: 'episode', runtime: '45m', hinted: false, hintedFor: [], unit: 'Show: Next 3 Episodes', step: Math.ceil((i + 1) / 3) }));
	game.lists.locked = { ok: true, message: '`Zack`: 0 ready, 60 locked, 0 done of 60.', which: 'locked', groups: [{ name: 'Show', kind: 'show', done: 0, total: 60, rows }] };
	const r = first(await runSlash(ana(), 'list', { show: 'locked' }));
	const [prev, next] = r.components[0].toJSON().components;
	assert.ok(prev.disabled && !next.disabled);
	const token = /^apmedia:page:([^:]+):1$/.exec(next.custom_id)[1];
	const kept = buttons._lists.get(token);
	assert.strictEqual(kept.userId, ANA);
	assert.ok(kept.pages.length >= 3);
	assert.ok(kept.pages.every((p) => p.length <= 2000 && p.startsWith('`Zack`: 0 ready, 60 locked')));
	assert.ok(kept.pages.every((p) => (p.match(/^\u2022 /gm) || []).length <= 22), 'at most 22 titles a page, to stay readable');
	assert.match(kept.pages[0], /\u2022 S01E01 \u00B7 45m \u00B7 opened by Show: Next 3 Episodes\n/);
	assert.match(kept.pages[0], /S01E04 \u00B7 45m \u00B7 opened by Show: Next 3 Episodes \(the 2nd\)/);
	assert.match(kept.pages[1], /\*\*Show\*\* \(0 of 60 done\) \(continued\)/);
	assert.match(kept.pages[kept.pages.length - 1], new RegExp(`Page ${kept.pages.length} of ${kept.pages.length}$`));
	const all = kept.pages.join('\n');
	for (let i = 1; i <= 60; i++) assert.strictEqual(all.split(`S01E${String(i).padStart(2, '0')} `).length - 1, 1, `episode ${i} once`);
	const short = first(await runPrefix(ana(), 'list'));
	assert.strictEqual(short.components, undefined, 'one page has no buttons');
	assert.match(first(await runPrefix(ana(), 'list sideways')).content, /No linked Plex Media slot is called `sideways`/, 'a word that is no view is the slot');
	game.lists.done = { ok: true, message: '`Zack`: nothing done.', which: 'done', groups: [] };
	assert.match(first(await runPrefix(ana(), 'list done')).content, /Nothing is done yet\./);
});

// The bug: a long heading repeated as "(continued)" over a long row, plus the page footer, made a
// page Discord refuses (2,075 characters at worst in a fuzz of the old code).
test('no page runs past 2,000 characters or loses its footer, however long a heading or a row', () => {
	const head = [`\`Slot\`: ${'h'.repeat(140)}`, '**Ready to watch or hear now:**'];
	const rows = Array.from({ length: 40 }, (_, i) => `\u2022 R${i}# ${'y'.repeat(i % 7 === 0 ? 2500 : 120)}`);
	const pages = common.paginate(head, [{ title: `**${'T'.repeat(220)}** (0 of 40 done)`, rows }]);
	assert.ok(pages.length > 1);
	for (const [i, page] of pages.entries()) {
		assert.ok(page.length <= 2000, `page ${i + 1} is ${page.length} characters`);
		assert.ok(page.endsWith(`\nPage ${i + 1} of ${pages.length}`), `page ${i + 1} keeps its footer`);
		assert.ok(page.startsWith(head.join('\n')));
		assert.match(page, /^\u2022 R\d+# /m, `page ${i + 1} holds a title, not a heading alone`);
	}
	const all = pages.join('\n');
	for (let i = 0; i < 40; i++) assert.strictEqual(all.split(`R${i}# `).length - 1, 1, `row ${i} once`);
	const single = common.paginate([`\`Slot\`: ${'x'.repeat(2100)}`], []);
	assert.deepStrictEqual(single.map((p) => p.length), [2000]);
	const emoji = common.paginate([`${'x'.repeat(1998)}\u{1F37F}${'y'.repeat(50)}`], []);
	assert.deepStrictEqual(emoji, [`${'x'.repeat(1998)}\u2026`], 'never half an emoji');
	const longRow = common.paginate(['h'], [{ title: null, rows: [`${'x'.repeat(1807)}\u{1F37F}${'y'.repeat(100)}`] }]);
	assert.deepStrictEqual(longRow, [`h\n${'x'.repeat(1807)}\u2026`], 'a long row is cut before an emoji, not through it');
});

test('status: a player sees their own slots, the owner anyone\'s, all of them with nothing named', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	const row = {
		key: '0::zack', watchId: 0, slot: 'Za`ck', userId: ANA, state: 'refused', connection: 'refused',
		stateDetail: { reason: 'InvalidPassword', fix: 'The room\'s password changed: set it with `!ap password 0 <password>`, then `/apmedia retry`.' },
		indexKnown: true, inventoryKnown: false, done: 3, total: 19, goalCount: 15, goalReached: false, ready: 3, locked: 13, pending: 2, banked: 4,
		wildTickets: { received: 2, used: 1, available: 1 }, account: { accountId: 7, name: 'Friend', consent: 'pending', implicit: false },
		lastSession: { title: 'The *Matrix* (1999)', percent: 87, note: '87%: Plex counts a watch at 90%' }, lastCredit: { at: 1731400000000, title: 'Alien' }, announce: false
	};
	game.status = (target) => {
		game.calls.push(['status', target]);
		return { ok: true, message: '1 Plex Media slot', reason: null, bindings: [row] };
	};
	const mine = first(await runSlash(ana(), 'status', {}));
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'status'), [['status', ANA]]);
	assert.match(mine.content, /\u{1F534} `Za'ck` on watch #0: refused/u);
	assert.ok(!mine.content.includes(`<@${ANA}>`), 'their own slot does not name them');
	assert.match(mine.content, /> Refused: The room's password changed/);
	assert.match(mine.content, /> 3 of 19 done, goal: finish 15\. 3 ready, 13 locked \(as at the start/);
	assert.match(mine.content, /> 2 checks waiting to send, 4 checks banked until their titles unlock\./);
	assert.match(mine.content, /> Wild Tickets: 1 to spend/);
	assert.match(mine.content, /> Plex account: `Friend` \(account 7\), waiting for their consent/);
	assert.match(mine.content, /> Last Plex session: \*\*The \\\*Matrix\\\* \(1999\)\*\*, reached 87%: Plex counts a watch at 90%\./);
	assert.match(mine.content, /> Last credit: \*\*Alien\*\* <t:1731400000:R>\./);
	assert.match(mine.content, /> Announcements: off\./);
	game.calls.length = 0;
	const theirs = first(await runSlash(owner(), 'status', {}));
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'status'), [['status', undefined]]);
	assert.match(theirs.content, /`Za'ck` on watch #0 for <@100000000000000001>: refused/);
	game.calls.length = 0;
	await runSlash(owner(), 'status', { user: ana() });
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'status'), [['status', ANA]]);
	assert.match(first(await runSlash(ben(), 'status', { user: ana() })).content, /Only the bot owner can see someone else's slots/);
	game.calls.length = 0;
	await runPrefix(ana(), 'status Zack');
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'status'), [['status', '0::zack']]);
});

// ---- autocomplete -----------------------------------------------------------------------------

function focus(who, sub, name, value, others = {}) {
	const responded = [];
	return {
		responded,
		commandName: 'apmedia',
		user: who,
		options: {
			getFocused: () => ({ name, value }),
			getSubcommand: () => sub,
			get: (n) => (others[n] === undefined ? null : { name: n, value: others[n] })
		},
		async respond(choices) { responded.push(choices); }
	};
}

test('autocomplete answers from memory: slots from the bindings, titles from the slot, playlists from the cache', async () => {
	const { game, builder } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	const auto = apmedia.command.slash.autocomplete;
	const a = focus(ana(), 'list', 'slot', 'za');
	await auto(a);
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'slotNames'), ['slotNames', 'za', ANA]);
	assert.deepStrictEqual(a.responded[0], [{ name: 'ZackPlex', value: '0::zackplex' }]);
	game.calls.length = 0;
	await auto(focus(owner(), 'list', 'slot', ''));
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'slotNames'), ['slotNames', '', null], 'the owner sees every slot where they may name one');
	game.calls.length = 0;
	await auto(focus(owner(), 'redeem', 'slot', ''));
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'slotNames'), ['slotNames', '', OWNER], 'redeem is the player\'s own');
	const t = focus(ana(), 'check', 'title', 'mat', { slot: '0::zack' });
	await auto(t);
	assert.deepStrictEqual(game.calls.find((c) => c[0] === 'titles'), ['titles', '0::zack', 'mat']);
	assert.strictEqual(t.responded[0].length, 25, 'at most 25 choices');
	game.lists.locked = {
		ok: true, message: '', which: 'locked',
		groups: [{ name: 'Movies', kind: 'movie', done: 0, total: 2, rows: [
			{ title: 'Heat (1995)', ref: 'movie|rk:7', kind: 'movie' },
			{ title: 'Alien (1979)', ref: 'movie|rk:8', kind: 'movie' }
		] }]
	};
	const locked = focus(ana(), 'redeem', 'title', 'ali');
	await auto(locked);
	assert.deepStrictEqual(locked.responded[0], [{ name: 'Alien (1979)', value: 'movie|rk:8' }], 'redeem offers the locked titles only');
	const p = focus(ana(), 'yaml', 'playlist', 'road');
	await auto(p);
	assert.deepStrictEqual(builder.calls, [['cachedPlaylists', 'road']]);
	assert.deepStrictEqual(p.responded[0][0], { name: 'Road Trip (audio, 30 items)', value: '501' });
	assert.ok(p.responded[0].every((c) => c.name.length <= 100 && c.value.length <= 100));
	config.apMediaEnabled = false;
	game.calls.length = 0;
	const off = focus(ana(), 'list', 'slot', 'za');
	await auto(off);
	assert.deepStrictEqual(off.responded, [[]]);
	assert.deepStrictEqual(game.calls, []);
});

test('the playlist autocomplete reads the game\'s builder, the one whose cache the game warms', async () => {
	const shared = stubBuilder();
	use({ game: stubGame({ builder: () => shared }), builder: null });
	const p = focus(ana(), 'yaml', 'playlist', 'road');
	await apmedia.command.slash.autocomplete(p);
	assert.deepStrictEqual(shared.calls, [['cachedPlaylists', 'road']]);
	assert.deepStrictEqual(p.responded[0][0], { name: 'Road Trip (audio, 30 items)', value: '501' });
});

test('an autocomplete that throws still answers, with nothing', async () => {
	const { game } = use();
	game.slotNames = () => { throw new Error('boom'); };
	const a = focus(ana(), 'list', 'slot', 'za');
	await apmedia.command.slash.autocomplete(a);
	assert.deepStrictEqual(a.responded, [[]]);
});

test('a subcommand that throws is answered, not left thinking', async () => {
	const { game } = use();
	game.bindings.push({ key: '0::zack', slot: 'Zack', userId: ANA, watchId: 0 });
	game.list = () => { throw new Error('boom'); };
	const r = first(await runSlash(ana(), 'list', {}));
	assert.match(r.content, /That did not work; the bot log has the error/);
});
