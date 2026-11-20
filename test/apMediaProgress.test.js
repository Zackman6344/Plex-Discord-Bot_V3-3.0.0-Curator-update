'use strict';

// /apmedia progress: the head and picks renderers, and run() against a fake game.progress.

const test = require('node:test');
const assert = require('node:assert');

const progress = require('../commands/apmedia.js/progress.js');
const { formatDuration, clock } = require('../helpers/apMediaGame.js');

const DOT = ' \u00b7 ';

function standing(over = {}) {
	return {
		entryKey: 'movie|The Matrix (1999)', ref: 'm1', title: 'The Matrix (1999)', kind: 'movie', runtimeMs: 8160000,
		status: 'ready', known: true, opener: null,
		checkpoints: { total: 8, earned: 2, next: { minute: 45, atMs: 2700000, id: 13 } },
		tracks: null, heard: null, fix: null,
		waiting: { pending: 0, banked: 0, held: 0 },
		expiredUntil: null, hints: [], distanceMs: 900000,
		text: { gap: null, gapAlone: null, fix: null, opener: null, tag: null },
		...over,
	};
}

test('progressText: head, checkpoints and nothing else for a plain open title', () => {
	const text = progress.progressText({ slot: 'Zack', standing: standing() });
	assert.deepStrictEqual(text.split('\n'), [
		`\u{1F513} **The Matrix (1999)** on \`Zack\`${DOT}${formatDuration(8160000)}${DOT}open`,
		`> Checkpoints: 2 of 8 earned; the next is at ${formatDuration(2700000)}.`,
	]);
});

test('progressText: locked opener, tracks, strict gap, waiting, expiry and the first three hints', () => {
	const s = standing({
		status: 'locked',
		checkpoints: { total: 3, earned: 3, next: null },
		tracks: { done: 4, total: 12 },
		heard: { throughMs: 600000, furthestMs: 2617000, gap: { fromMs: 600000, toMs: 1127000 }, heldBack: [{ minute: 15, atMs: 900000, id: 11 }] },
		waiting: { pending: 1, banked: 0, held: 2 },
		expiredUntil: 1800000000500,
		hints: [
			{ receiver: 'Ann', item: 'Key A', priority: true },
			{ receiver: 'B`ob', item: 'Key_B', priority: false },
			{ receiver: 'Cy', item: 'K3', priority: false },
			{ receiver: 'Di', item: 'K4', priority: true },
		],
		text: { gapAlone: 'Nothing heard from here.', fix: 'Rewind to 10:00.', opener: 'It opens when **1917 (movie)** arrives.' },
	});
	assert.deepStrictEqual(progress.progressText({ slot: 'Zack', standing: s }).split('\n'), [
		`\u{1F512} **The Matrix (1999)** on \`Zack\`${DOT}${formatDuration(8160000)}${DOT}locked`,
		'> It opens when **1917 (movie)** arrives.',
		'> Checkpoints: 3 of 3 earned.',
		'> Tracks: 4 of 12 done.',
		`> Heard through ${clock(600000)}, and from ${clock(1127000)} to ${clock(2617000)}.`,
		'> Nothing heard from here. Rewind to 10:00.',
		'> Waiting: 1 check to send and 2 held by a trap.',
		'> \u26d4 Rights expired until <t:1800000000:t>.',
		"> \u{1F4A1} Hinted: **Key A** for `Ann` (priority); **Key\\_B** for `B'ob`; **K3** for `Cy` and 1 more.",
	]);
});

test('progressText: no checkpoint line without checkpoints; heard lines without a gap', () => {
	const none = progress.progressText({ slot: 'Zack', standing: standing({ status: 'done', checkpoints: { total: 0, earned: 0, next: null }, heard: { throughMs: 0, furthestMs: 0, gap: null, heldBack: [] } }) });
	assert.deepStrictEqual(none.split('\n').slice(1), ['> Nothing heard yet.']);
	assert.match(none, /^\u2705 /);
	assert.match(none, /\u00b7 done$/m);
	const through = progress.progressText({ slot: 'Zack', standing: standing({ heard: { throughMs: 600000, furthestMs: 600000, gap: null, heldBack: [] }, waiting: { pending: 2, banked: 3, held: 0 } }) });
	assert.ok(through.includes(`\n> Heard through ${clock(600000)}.\n`));
	assert.ok(through.endsWith('\n> Waiting: 2 checks to send and 3 banked until it unlocks.'));
	const open = progress.progressText({ slot: 'Zack', standing: standing({ text: { opener: 'It opens when **X** arrives.' } }) });
	assert.ok(!open.includes('It opens'));
});

test('picksText: one line per kind of pick, the count and the footer', () => {
	const picks = [
		standing({ title: 'Gap', heard: { throughMs: 600000, furthestMs: 2617000, gap: { fromMs: 600000, toMs: 1127000 }, heldBack: [{ atMs: 900000 }] } }),
		standing({ title: 'Hinted', hints: [{ receiver: 'Ann', item: 'x', priority: false }, { receiver: 'Bo', item: 'y', priority: true }], checkpoints: { total: 4, earned: 0, next: { atMs: 900000 } } }),
		standing({ title: 'Started', checkpoints: { total: 4, earned: 1, next: { atMs: 1800000 } }, distanceMs: 240000 }),
		standing({ title: 'Fresh', checkpoints: { total: 4, earned: 0, next: { atMs: 300000 } }, distanceMs: 300000 }),
		standing({ title: 'Album', checkpoints: { total: 0, earned: 0, next: null }, distanceMs: 2400000 }),
	];
	const run = formatDuration(8160000);
	assert.deepStrictEqual(progress.picksText({ slot: 'Zack', open: 7, picks }, '!').split('\n'), [
		'What to watch next on `Zack`: 7 titles open.',
		`\u2022 **Gap**${DOT}${run}${DOT}\u{1F6A7} held back by a gap from ${clock(600000)} to ${clock(1127000)}`,
		`\u2022 **Hinted**${DOT}${run}${DOT}\u{1F4A1} hinted for \`Bo\` (priority)${DOT}next check at ${formatDuration(900000)}`,
		`\u2022 **Started**${DOT}${run}${DOT}next check at ${formatDuration(1800000)}, ${formatDuration(240000)} away`,
		`\u2022 **Fresh**${DOT}${run}${DOT}first check at ${formatDuration(300000)}`,
		`\u2022 **Album**${DOT}${run}${DOT}${formatDuration(2400000)} to finish`,
		'`!apmedia progress <title>` shows one in full.',
	]);
	assert.match(progress.picksText({ slot: 'Zack', open: 1, picks: picks.slice(3, 4) }, '!'), /: 1 title open\./);
	assert.strictEqual(progress.picksText({ slot: 'Za`ck', open: 0, picks: [] }, '!'), "Nothing on `Za'ck`'s list is open and unfinished.");
});

function fakeCtx({ rest = '', out, found = null }) {
	const calls = { resolve: [], find: [], progress: [], said: [] };
	const ctx = {
		rest, p: '!', userId: 'U1',
		say: async (x) => { calls.said.push(x); },
		buttons: { firstPage: ({ pages }) => ({ content: pages[0], components: [] }) },
		game: {
			resolveBinding: (text, opts) => { calls.resolve.push([text, opts]); return { ok: true, key: 'k1' }; },
			findEntry: (key, text) => { calls.find.push([key, text]); return found || { ok: true, entryKey: 'movie|The Matrix (1999)', title: 'The Matrix (1999)' }; },
			progress: async (key, entryKey) => { calls.progress.push([key, entryKey]); return out; },
		},
	};
	return { ctx, calls };
}

test('run: no title asks for picks; a title goes through findEntry; a refusal is said as is', async () => {
	const picks = fakeCtx({ out: { ok: true, key: 'k1', slot: 'Zack', open: 0, picks: [] } });
	await progress.run(picks.ctx);
	assert.deepStrictEqual(picks.calls.progress, [['k1', null]]);
	assert.deepStrictEqual(picks.calls.find, []);
	assert.deepStrictEqual(picks.calls.said, ["Nothing on `Zack`'s list is open and unfinished."]);

	const one = fakeCtx({ rest: 'The Matrix (1999)', out: { ok: true, key: 'k1', slot: 'Zack', standing: standing() } });
	await progress.run(one.ctx);
	assert.deepStrictEqual(one.calls.find, [['k1', 'The Matrix (1999)']]);
	assert.deepStrictEqual(one.calls.progress, [['k1', 'movie|The Matrix (1999)']]);
	assert.match(one.calls.said[0], /^\u{1F513} \*\*The Matrix \(1999\)\*\* on `Zack`/u);

	const refused = fakeCtx({ out: { ok: false, message: 'There is no such Plex Media slot.' } });
	await progress.run(refused.ctx);
	assert.deepStrictEqual(refused.calls.said, ['There is no such Plex Media slot.']);

	const missing = fakeCtx({ rest: 'Nope', out: null, found: { ok: false, message: 'No such title.' } });
	missing.ctx.game.titles = () => [];
	missing.ctx.game.list = () => ({ ok: true, rows: [] });
	await progress.run(missing.ctx);
	assert.deepStrictEqual(missing.calls.progress, []);
	assert.strictEqual(missing.calls.said.length, 1);
});

test('/apmedia stays within the wave 1 budget with progress after list', () => {
	const apmedia = require('../commands/apmedia.js/index.js');
	const { buildSpec } = require('../helpers/slashRegistry.js');
	const { commandChars } = require('../scripts/validate-slash.js');
	const names = apmedia._internal.SUBCOMMANDS.map((s) => s.name);
	assert.strictEqual(names[names.indexOf('list') + 1], 'progress');
	assert.ok(names.length <= 16, `${names.length} subcommands`);
	const chars = commandChars(buildSpec('apmedia', apmedia.command.slash));
	assert.ok(chars <= 3635, `${chars} characters`);
});

test('run: slot= is taken from the prefix text and asked for with others allowed', async () => {
	const config = require('../config/config.js');
	const saved = config.ownerId;
	config.ownerId = 'OWNER1';
	const { ctx, calls } = fakeCtx({ rest: 'slot=Zack', out: { ok: true, key: 'k1', slot: 'Zack', open: 0, picks: [] } });
	ctx.userId = 'OWNER1';
	try {
		await progress.run(ctx);
	} finally {
		config.ownerId = saved;
	}
	assert.strictEqual(calls.resolve[0][0], 'Zack');
	assert.strictEqual(calls.resolve[0][1].all, true);
	assert.deepStrictEqual(calls.progress, [['k1', null]]);
	assert.deepStrictEqual(calls.find, []);
});

// The sentences of 02-interfaces.md 2.7 as the game writes them, with its commandCode.
function gameText(p, ref, ff) {
	const { commandCode } = require('../helpers/apMediaGame.js');
	const tail = ff === 'price'
		? ` One Fast Forward covers the gap, and the Snack Bar trades one for 40 snacks: ${commandCode(`${p}apmedia snackbar buy fast-forward`)}.`
		: ` One Fast Forward covers the gap: ${commandCode(`${p}apmedia ff ${ref}`)} (1 on hand).`;
	return {
		gap: null, tag: null,
		gapAlone: 'Nothing heard from 10:00 to 18:47, so its checkpoints from 15m on wait.',
		fix: `Rewind to 10:00, or if you watched it: ${commandCode(`${p}apmedia check ${ref} at 43:37`)}.${tail} Plex's Skip Intro made that gap: ${commandCode(`${p}apmedia switch intro on`)} counts a skipped intro as heard.`,
		opener: `It opens when **1917 (movie)** arrives. A Wild Ticket opens it: ${commandCode(`${p}apmedia redeem ${ref}`)} (2 on hand).`,
	};
}

function lockedGap(ref, ff) {
	return standing({
		ref, status: 'locked',
		checkpoints: { total: 3, earned: 0, next: { minute: 15, atMs: 900000, id: 11 } },
		heard: { throughMs: 600000, furthestMs: 2617000, gap: { fromMs: 600000, toMs: 1127000 }, heldBack: [{ minute: 15, atMs: 900000, id: 11 }] },
		text: gameText('!', ref, ff),
	});
}

function ownerCtx({ rest, out, mine }) {
	const made = fakeCtx({ rest, out });
	made.ctx.userId = 'OWNER1';
	made.ctx.game.resolveBinding = (text, opts) => {
		made.calls.resolve.push([text, opts]);
		return opts.all || mine ? { ok: true, key: 'k2' } : { ok: false, message: 'No linked Plex Media slot is called `k2`.' };
	};
	return made;
}

async function asOwner(fn) {
	const config = require('../config/config.js');
	const saved = config.ownerId;
	config.ownerId = 'OWNER1';
	try {
		return await fn();
	} finally {
		config.ownerId = saved;
	}
}

const FRIEND_LINES = [
	'> It opens when **1917 (movie)** arrives. A Wild Ticket opens it (2 on hand).',
	'> Checkpoints: 0 of 3 earned; the next is at ' + formatDuration(900000) + '.',
	`> Heard through ${clock(600000)}, and from ${clock(1127000)} to ${clock(2617000)}.`,
	"> Nothing heard from 10:00 to 18:47, so its checkpoints from 15m on wait. Rewind to 10:00. One Fast Forward covers the gap (1 on hand). Plex's Skip Intro made that gap.",
];

test('run: the owner on a friend\'s slot gets the opener and fix without the commands, which act on the owner\'s own slot', async () => {
	const out = { ok: true, key: 'k2', slot: 'Ana', standing: lockedGap('m1') };
	const { ctx, calls } = ownerCtx({ rest: 'The Matrix (1999) slot=Ana', out, mine: false });
	await asOwner(() => progress.run(ctx));
	assert.deepStrictEqual(calls.resolve, [['Ana', { userId: 'OWNER1', all: true }], ['k2', { userId: 'OWNER1', all: false }]]);
	assert.deepStrictEqual(calls.said[0].split('\n').slice(1), FRIEND_LINES);
	assert.ok(!calls.said[0].includes('apmedia'), calls.said[0]);

	const priced = progress.progressText({ slot: 'Ana', standing: lockedGap('m1', 'price') }, false).split('\n');
	assert.strictEqual(priced[4], "> Nothing heard from 10:00 to 18:47, so its checkpoints from 15m on wait. Rewind to 10:00. One Fast Forward covers the gap, and the Snack Bar trades one for 40 snacks. Plex's Skip Intro made that gap.");
	const fenced = progress.progressText({ slot: 'Ana', standing: lockedGap('m`1') }, false);
	assert.deepStrictEqual(fenced.split('\n').slice(1), FRIEND_LINES);
	const byLock = lockedGap('m1');
	byLock.text = { ...byLock.text, gapAlone: 'It was played to 18:47 while it was locked.', fix: 'Rewind to the start.' };
	assert.ok(progress.progressText({ slot: 'Ana', standing: byLock }, false).endsWith('\n> It was played to 18:47 while it was locked. Rewind to the start.'));
	assert.strictEqual(progress.withoutCommands('Then type ``!apmedia ff m`1`` now.'), 'Then type now.');
});

test('run: the owner on an own slot named with slot= keeps every command as the game wrote it', async () => {
	const s = lockedGap('m1');
	const { ctx, calls } = ownerCtx({ rest: 'The Matrix (1999) slot=Zack', out: { ok: true, key: 'k2', slot: 'Zack', standing: s }, mine: true });
	await asOwner(() => progress.run(ctx));
	const lines = calls.said[0].split('\n');
	assert.strictEqual(lines[1], `> ${s.text.opener}`);
	assert.strictEqual(lines[4], `> ${s.text.gapAlone} ${s.text.fix}`);
	assert.strictEqual(lines[4].match(/`!apmedia /g).length, 3);
	assert.strictEqual(progress.progressText({ slot: 'Zack', standing: s }), calls.said[0]);
});

test('picksText: a friend\'s slot is named in the footer as takeKeys reads it, quoted around a space', async () => {
	const common = require('../commands/apmedia.js/common.js');
	const picks = [standing({ title: 'Fresh', checkpoints: { total: 4, earned: 0, next: { atMs: 300000 } }, distanceMs: 300000 })];
	const footer = (slot, own) => progress.picksText({ slot, open: 1, picks }, '!', own).split('\n').slice(2);
	assert.deepStrictEqual(footer('Zack 2', true), ['`!apmedia progress <title>` shows one in full.']);
	assert.deepStrictEqual(footer('Ana', false), ['`!apmedia progress <title> slot=Ana` shows one in full.']);
	assert.deepStrictEqual(footer('Zack 2', false), ['`!apmedia progress <title> slot="Zack 2"` shows one in full.']);
	assert.deepStrictEqual(footer('Ana"s', false), ['`!apmedia progress <title> slot=Ana"s` shows one in full.']);
	assert.deepStrictEqual(footer('"Bo', false), []);
	assert.deepStrictEqual(footer('Bo "B" Jo', false), []);
	for (const name of ['Ana', 'Zack 2', 'Ana"s', "'Tis", 'a=b']) {
		const pair = progress.slotPair(name);
		assert.deepStrictEqual(common.takeKeys(`The Matrix ${pair}`, ['slot']), { values: { slot: name }, rest: 'The Matrix' }, name);
	}

	const spaced = { ok: true, key: 'k2', slot: 'Zack 2', standing: lockedGap('m1') };
	const one = ownerCtx({ rest: 'The Matrix (1999) slot="Zack 2"', out: spaced, mine: false });
	await asOwner(() => progress.run(one.ctx));
	assert.strictEqual(one.calls.resolve[0][0], 'Zack 2');
	assert.deepStrictEqual(one.calls.said[0].split('\n').slice(1), FRIEND_LINES);
	const list = ownerCtx({ rest: 'slot="Zack 2"', out: { ok: true, key: 'k2', slot: 'Zack 2', open: 1, picks }, mine: false });
	await asOwner(() => progress.run(list.ctx));
	assert.ok(list.calls.said[0].endsWith('\n`!apmedia progress <title> slot="Zack 2"` shows one in full.'), list.calls.said[0]);
});

const GAP_MARK = String.fromCodePoint(0x1F6A7);
const BULLET = String.fromCodePoint(0x2022);

function heldTitle(title, entryKey, fromMs, toMs, furthestMs) {
	return { entryKey, title, ref: entryKey, gap: { fromMs, toMs }, furthestMs };
}

// The bug: with no title, progress listed at most five open titles, while the status line and the
// episodes line sent the player there for every title a gap holds back, finished ones included.
test('picks: every title a gap holds back comes first in its own block, a done one too, and a pick among them is not named twice', async () => {
	const matrix = heldTitle('The Matrix (1999)', 'movie|rk:2001', 960000, 1200000, 8160000);
	const tiny = heldTitle('Tiny_Show S01E01', 'episode|rk:2101', 40000, 115000, 1320000);
	const tinyPick = standing({ entryKey: 'episode|rk:2101', title: 'Tiny_Show S01E01', heard: { throughMs: 40000, furthestMs: 1320000, gap: { fromMs: 40000, toMs: 115000 }, heldBack: [{ atMs: 600000 }] } });
	const fresh = standing({ entryKey: 'movie|rk:2003', title: 'Halloween (2018)', checkpoints: { total: 4, earned: 0, next: { atMs: 900000 } }, distanceMs: 900000 });
	const out = { ok: true, key: 'k1', slot: 'Zack', open: 2, picks: [tinyPick, fresh], held: [matrix, tiny] };
	const { ctx, calls } = fakeCtx({ out });
	await progress.run(ctx);
	assert.deepStrictEqual(calls.progress, [['k1', null]]);
	assert.deepStrictEqual(calls.said[0].split('\n'), [
		'What to watch next on `Zack`: 2 titles open.',
		`${GAP_MARK} 2 titles have checkpoints held back by a gap`,
		`> **The Matrix (1999)**${DOT}gap from ${clock(960000)} to ${clock(1200000)}, heard to ${clock(8160000)}`,
		`> **Tiny\\_Show S01E01**${DOT}gap from ${clock(40000)} to ${clock(115000)}, heard to ${clock(1320000)}`,
		`${BULLET} **Halloween (2018)**${DOT}${formatDuration(8160000)}${DOT}first check at ${formatDuration(900000)}`,
		'`!apmedia progress <title>` shows one in full.',
	]);
});

test('picks: with nothing open the held titles still show, under the nothing line and over the footer', () => {
	const out = { ok: true, key: 'k1', slot: 'Zack', open: 0, picks: [], held: [heldTitle('The Matrix (1999)', 'movie|rk:2001', 960000, 1200000, 8160000)] };
	assert.deepStrictEqual(progress.picksPages(out, '!'), [[
		"Nothing on `Zack`'s list is open and unfinished.",
		`${GAP_MARK} 1 title has checkpoints held back by a gap`,
		`> **The Matrix (1999)**${DOT}gap from ${clock(960000)} to ${clock(1200000)}, heard to ${clock(8160000)}`,
		'`!apmedia progress <title>` shows one in full.',
	].join('\n')]);
	assert.ok(progress.picksPages({ ...out, slot: 'Zack 2' }, '!', false)[0].endsWith('\n`!apmedia progress <title> slot="Zack 2"` shows one in full.'));
	assert.ok(progress.picksPages({ ...out, slot: '"Bo' }, '!', false)[0].endsWith(`, heard to ${clock(8160000)}`));
	const onlyPick = standing({ entryKey: 'movie|rk:2001', title: 'The Matrix (1999)' });
	assert.deepStrictEqual(progress.picksPages({ ...out, open: 1, picks: [onlyPick] }, '!')[0].split('\n').slice(0, 2), [
		'What to watch next on `Zack`: 1 title open.',
		`${GAP_MARK} 1 title has checkpoints held back by a gap`,
	]);
	const gapless = { entryKey: 'movie|rk:2009', title: 'Odd', ref: 'movie|rk:2009', gap: null, furthestMs: 0 };
	assert.strictEqual(progress.picksPages({ ...out, held: [gapless] }, '!')[0].split('\n')[2], '> **Odd**');
	const fresh = [standing({ title: 'Fresh', checkpoints: { total: 4, earned: 0, next: { atMs: 300000 } }, distanceMs: 300000 })];
	for (const [open, picks] of [[0, []], [1, fresh]]) {
		for (const held of [[], undefined, null]) {
			const plain = { ok: true, key: 'k1', slot: 'Zack', open, picks, held };
			assert.deepStrictEqual(progress.picksPages(plain, '!'), [progress.picksText(plain, '!')]);
		}
	}
});

test('picks: a long held list is paged with the reply, each title once, every page within a message', async () => {
	const held = Array.from({ length: 60 }, (_, i) => heldTitle(`A Show With Quite A Long Name S01E${String(i + 1).padStart(2, '0')}`, `episode|rk:${3000 + i}`, 40000, 115000, 1320000));
	const out = { ok: true, key: 'k1', slot: 'Zack', open: 61, picks: [standing({ entryKey: 'movie|rk:2003', title: 'Halloween (2018)' })], held };
	const { ctx, calls } = fakeCtx({ out });
	const given = [];
	ctx.buttons.firstPage = ({ pages }) => {
		given.push(pages);
		return { content: pages[0], components: pages.length > 1 ? [{ type: 1 }] : [] };
	};
	await progress.run(ctx);
	assert.strictEqual(given.length, 1);
	const pages = given[0];
	assert.ok(pages.length > 1, `${pages.length} pages`);
	assert.deepStrictEqual(calls.said, [{ content: pages[0], components: [{ type: 1 }] }]);
	for (const page of pages) {
		assert.ok(page.length <= 2000, `${page.length} characters`);
		assert.ok(page.startsWith('What to watch next on `Zack`: 61 titles open.\n'), page);
	}
	const all = pages.join('\n');
	for (const h of held) assert.strictEqual(all.split(`**${h.title}**`).length - 1, 1, h.title);
	assert.ok(pages[1].includes(`${GAP_MARK} 60 titles have checkpoints held back by a gap (continued)`), pages[1]);
	assert.ok(pages.at(-1).includes(`\n${BULLET} **Halloween (2018)**`), pages.at(-1));
	assert.match(pages.at(-1), /\n`!apmedia progress <title>` shows one in full\.\nPage (\d+) of \1$/);
});

// The bug: the help showed `[slot]`, and a slot typed after the title became part of the title.
test('the help shows the slot form the prefix parser reads, and a slot typed that way is the slot', async () => {
	const apmedia = require('../commands/apmedia.js/index.js');
	const help = apmedia._internal.helpEmbed({ config: { commandPrefix: '!' } }).data.description;
	const line = help.split('\n').find((l) => l.startsWith('> `!apmedia progress '));
	const form = /^> `!apmedia progress \[title\] \[([^\]]+)\]`/.exec(line)[1];
	const typed = form === 'slot' ? 'ZackTestPlex' : form.replace(/=x$/, '=ZackTestPlex');
	const { ctx, calls } = fakeCtx({ rest: `The Matrix (1999) ${typed}`, out: { ok: true, key: 'k1', slot: 'ZackTestPlex', standing: standing() } });
	await progress.run(ctx);
	assert.strictEqual(calls.resolve[0][0], 'ZackTestPlex', line);
	assert.deepStrictEqual(calls.find, [['k1', 'The Matrix (1999)']]);
	assert.strictEqual(line, '> `!apmedia progress [title] [slot=x]`: Where a title stands and what holds it back; with no title, up to five titles to watch next.');
});
