// helpers/apMediaButtons.js: the page buttons on a long /apmedia list or status, and the Accept
// button a friend presses before the bot reads their Plex history.
//
// What has to hold: a click on any other button is left for the next handler; a page turns only
// for the person who asked, never sends more than 2,000 characters, and a list left alone for half an hour has expired (answered privately,
// never "This interaction failed"); at most 50 lists are kept; only the person an Accept button
// names can press it; a request older than seven days, replaced by a newer link, withdrawn or
// answered already grants nothing; the grant happens once, after the click is acknowledged, and the
// button is gone afterwards; nothing pings anyone.
//
// Harness: the helper on its own with recording fake interactions, a stand-in for the game's
// accountOf and grantConsent, and a hand-set clock through _use.

const test = require('node:test');
const assert = require('node:assert');

const buttons = require('../helpers/apMediaButtons.js');

const T0 = 1791500000000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ASKER = '100000000000000001';
const OTHER = '100000000000000002';
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };

let clock = T0;
let restore = null;

test.beforeEach(() => {
	clock = T0;
	buttons._lists.clear();
	restore = buttons._use({ now: () => clock, game: null });
});
test.afterEach(() => {
	if (restore) restore();
	restore = null;
	buttons._lists.clear();
});

function click(customId, userId = ASKER, extra = {}) {
	const calls = [];
	return Object.assign({
		customId,
		user: { id: userId },
		calls,
		async update(p) { calls.push(['update', p]); },
		async reply(p) { calls.push(['reply', p]); },
		async deferUpdate() { calls.push(['deferUpdate']); },
		async editReply(p) { calls.push(['editReply', p]); },
		async followUp(p) { calls.push(['followUp', p]); }
	}, extra);
}

async function press(customId, userId = ASKER, opts, extra) {
	const i = click(customId, userId, extra);
	assert.strictEqual(await buttons.handle(i, null, null, opts), true, `${customId} was not claimed`);
	return i;
}

function ids(components) {
	return components
		.map((r) => (typeof r.toJSON === 'function' ? r.toJSON() : r))
		.flatMap((r) => r.components)
		.map((b) => ({ id: b.custom_id, label: b.label, disabled: Boolean(b.disabled) }));
}

function pagesOf(n) {
	return Array.from({ length: n }, (_, i) => `Page ${i + 1} of ${n} for <@${OTHER}> @everyone`);
}

function fakeGame(account) {
	const calls = [];
	const game = {
		calls,
		account,
		accountOf(userId) {
			calls.push(['accountOf', userId]);
			return game.account;
		},
		async grantConsent(userId, opts) {
			calls.push(['grantConsent', userId, opts]);
			game.account = { ...game.account, consent: 'granted' };
			return { ok: true, message: 'Accepted: the Plex history of `Friend` (account 7) counts for your Plex Media slots.' };
		}
	};
	return game;
}

const pending = (over = {}) => ({ accountId: 7, name: 'Friend', consent: 'pending', implicit: false, linkedAt: T0, linkedBy: '100000000000000009', ...over });

test('clicks meant for other buttons are left for the next handler', async () => {
	for (const id of ['apnext:abc:1', 'book:toggle:abc', 'playback:pause', 'apmedia:other:x', 'apmedia', '', undefined]) {
		const i = click(id);
		assert.strictEqual(await buttons.handle(i, null, null, {}), false, String(id));
		assert.deepStrictEqual(i.calls, []);
	}
	assert.ok(buttons.owns('apmedia:page:x:1') && buttons.owns('apmedia:consent:1.a'));
	assert.ok(!buttons.owns('apmedia:pages:x') && !buttons.owns(null));
});

test('one page needs no buttons; more get previous and next, carrying the page each turns to', () => {
	const single = buttons.firstPage({ userId: ASKER, pages: ['only'] });
	assert.deepStrictEqual(single, { content: 'only', components: [] });
	assert.strictEqual(buttons._lists.size, 0, 'nothing is kept for a single page');
	const many = buttons.firstPage({ userId: ASKER, pages: pagesOf(3) });
	assert.strictEqual(many.content, pagesOf(3)[0]);
	const [prev, next] = ids(many.components);
	const token = /^apmedia:page:([^:]+):-1$/.exec(prev.id)[1];
	assert.deepStrictEqual([prev, next], [
		{ id: `apmedia:page:${token}:-1`, label: '\u25C0', disabled: true },
		{ id: `apmedia:page:${token}:1`, label: '\u25B6', disabled: false }
	]);
	assert.deepStrictEqual(buttons._lists.get(token).userId, ASKER);
	assert.ok(`apmedia:page:${token}:1`.length <= 100);
	const other = buttons.register({ userId: ASKER, pages: pagesOf(2) });
	assert.notStrictEqual(other, token, 'two lists in one millisecond get their own tokens');
});

test('the asker walks the pages forward and back, each click replacing the message without pings', async () => {
	const token = buttons.register({ userId: ASKER, pages: pagesOf(3) });
	const seen = [];
	for (const page of [1, 2, 1, 0]) {
		const payload = (await press(`apmedia:page:${token}:${page}`)).calls[0][1];
		seen.push(payload.content);
		assert.deepStrictEqual(payload.allowedMentions, NO_PINGS);
		const [prev, next] = ids(payload.components);
		assert.strictEqual(prev.disabled, page === 0);
		assert.strictEqual(next.disabled, page === 2);
	}
	assert.deepStrictEqual(seen, [pagesOf(3)[1], pagesOf(3)[2], pagesOf(3)[1], pagesOf(3)[0]]);
	const off = await press(`apmedia:page:${token}:99`);
	assert.strictEqual(off.calls[0][1].content, pagesOf(3)[2], 'a page past the end shows the last');
	const junk = await press(`apmedia:page:${token}:x`);
	assert.strictEqual(junk.calls[0][1].content, pagesOf(3)[0]);
});

// The bug: the first page went out clipped through the command's say(), a turned page as stored, and
// Discord refuses a message over 2,000 characters ("This interaction failed").
test('a turned page is never longer than Discord takes, and never ends in half an emoji', async () => {
	const long = `${'x'.repeat(1998)}\u{1F37F}${'y'.repeat(50)}`;
	const token = buttons.register({ userId: ASKER, pages: ['short', long] });
	const payload = (await press(`apmedia:page:${token}:1`)).calls[0][1];
	assert.strictEqual(payload.content, `${'x'.repeat(1998)}\u2026`);
	const back = (await press(`apmedia:page:${token}:0`)).calls[0][1];
	assert.strictEqual(back.content, 'short');
});

test('somebody other than the asker is refused privately, and the pages do not move', async () => {
	const token = buttons.register({ userId: ASKER, pages: pagesOf(2) });
	const i = await press(`apmedia:page:${token}:1`, OTHER);
	assert.deepStrictEqual(i.calls.map((c) => c[0]), ['reply']);
	assert.deepStrictEqual(i.calls[0][1], { content: 'Only the person who asked can turn these pages.', flags: EPHEMERAL, allowedMentions: NO_PINGS });
	const mine = await press(`apmedia:page:${token}:1`, ASKER);
	assert.strictEqual(mine.calls[0][0], 'update');
});

test('a list is kept for half an hour after its last use, then answers privately that it has expired', async () => {
	const token = buttons.register({ userId: ASKER, pages: pagesOf(2) });
	clock = T0 + 29 * MIN;
	assert.strictEqual((await press(`apmedia:page:${token}:1`)).calls[0][0], 'update');
	clock = T0 + 58 * MIN;
	assert.strictEqual((await press(`apmedia:page:${token}:0`)).calls[0][0], 'update', 'the turn at 29 minutes renewed it');
	clock = T0 + 89 * MIN;
	const late = await press(`apmedia:page:${token}:1`);
	assert.deepStrictEqual(late.calls, [['reply', { content: 'This list has expired. Ask for it again to see it as it is now.', flags: EPHEMERAL, allowedMentions: NO_PINGS }]]);
	assert.ok(!buttons._lists.has(token));
});

test('no more than 50 lists are kept, the ones used longest ago going first', () => {
	const tokens = [];
	for (let n = 0; n < 51; n++) tokens.push(buttons.register({ userId: ASKER, pages: pagesOf(2) }));
	assert.strictEqual(buttons._lists.size, 50);
	assert.ok(!buttons._lists.has(tokens[0]));
	assert.ok(buttons._lists.has(tokens[50]));
});

test('the command log sees every answer, and an observer that throws changes nothing', async () => {
	const token = buttons.register({ userId: ASKER, pages: pagesOf(2) });
	const seen = [];
	await press(`apmedia:page:${token}:1`, ASKER, { onInteractionResponse: (p) => seen.push(p.content) });
	await press(`apmedia:page:${token}:0`, OTHER, { onInteractionResponse: (p) => seen.push(p.content) });
	assert.deepStrictEqual(seen, [pagesOf(2)[1], 'Only the person who asked can turn these pages.']);
	const i = await press(`apmedia:page:${token}:1`, ASKER, { onInteractionResponse: () => { throw new Error('observer'); } });
	assert.strictEqual(i.calls[0][0], 'update');
});

test('an Accept button names its user and the moment of the link, and fits a custom id', () => {
	const [button] = ids([buttons.consentRow(ASKER, T0)]);
	assert.strictEqual(button.id, `apmedia:consent:${ASKER}.${T0.toString(36)}`);
	assert.strictEqual(button.label, 'Accept');
	assert.ok(button.id.length <= 100);
	assert.strictEqual(buttons.consentToken(ASKER, T0), `${ASKER}.${T0.toString(36)}`);
});

test('only the person an Accept button names can press it', async () => {
	const game = fakeGame(pending());
	buttons._use({ game });
	const id = `apmedia:consent:${buttons.consentToken(ASKER, T0)}`;
	const i = await press(id, OTHER);
	assert.deepStrictEqual(i.calls, [['reply', { content: `Only <@${ASKER}> can accept this.`, flags: EPHEMERAL, allowedMentions: NO_PINGS }]]);
	assert.deepStrictEqual(game.calls, [], 'the game is not even asked');
	assert.strictEqual(game.account.consent, 'pending');
});

test('pressing Accept acknowledges the click, grants once and takes the button away', async () => {
	const game = fakeGame(pending());
	buttons._use({ game });
	clock = T0 + 6 * DAY;
	const seen = [];
	const original = { content: 'The bot owner linked you to the Plex account `Friend`.' };
	const i = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER, { onInteractionResponse: (p) => seen.push(p) }, { message: original });
	assert.deepStrictEqual(i.calls.map((c) => c[0]), ['deferUpdate', 'editReply']);
	const payload = i.calls[1][1];
	assert.deepStrictEqual(payload.components, []);
	assert.deepStrictEqual(payload.allowedMentions, NO_PINGS);
	assert.ok(payload.content.startsWith(original.content), 'what they accepted stays on the message');
	assert.match(payload.content, /\u2705 Accepted: the Plex history of `Friend`/);
	assert.deepStrictEqual(game.calls.filter((c) => c[0] === 'grantConsent'), [['grantConsent', ASKER, { linkedAt: T0 }]]);
	assert.deepStrictEqual(seen, [payload]);
	const again = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER);
	assert.deepStrictEqual(again.calls.map((c) => c[0]), ['update']);
	assert.match(again.calls[0][1].content, /accepted this already/);
	assert.strictEqual(game.calls.filter((c) => c[0] === 'grantConsent').length, 1);
});

test('a request older than seven days grants nothing and says so', async () => {
	const game = fakeGame(pending());
	buttons._use({ game });
	clock = T0 + 7 * DAY + 1;
	const i = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER);
	assert.deepStrictEqual(i.calls.map((c) => c[0]), ['update']);
	assert.deepStrictEqual(i.calls[0][1], { content: 'This request has expired. Ask the owner to link your Plex account again.', components: [], allowedMentions: NO_PINGS });
	assert.ok(!game.calls.some((c) => c[0] === 'grantConsent'));
	clock = T0 + 7 * DAY;
	const edge = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER);
	assert.deepStrictEqual(edge.calls.map((c) => c[0]), ['deferUpdate', 'editReply'], 'exactly seven days is still in time');
});

test('a button from an older link, a withdrawn link or a broken id grants nothing', async () => {
	const game = fakeGame(pending({ linkedAt: T0 + MIN, accountId: 8, name: 'Other' }));
	buttons._use({ game });
	const old = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER);
	assert.deepStrictEqual(old.calls.map((c) => c[0]), ['update']);
	assert.match(old.calls[0][1].content, /linked your Plex account again since this request: answer the newer one/);
	game.account = null;
	const gone = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0 + MIN)}`, ASKER);
	assert.match(gone.calls[0][1].content, /withdrawn/);
	game.account = { accountId: 1, name: null, consent: 'granted', implicit: true, linkedAt: null };
	const owner = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0 + MIN)}`, ASKER);
	assert.match(owner.calls[0][1].content, /withdrawn/, 'the owner\'s implicit account is no request to accept');
	const broken = await press('apmedia:consent:not-a-token', ASKER);
	assert.deepStrictEqual(broken.calls.map((c) => c[0]), ['reply']);
	assert.strictEqual(broken.calls[0][1].flags, EPHEMERAL);
	assert.ok(!game.calls.some((c) => c[0] === 'grantConsent'));
});

test('a grant the game refuses is answered privately and leaves the button', async () => {
	const game = fakeGame(pending());
	game.grantConsent = async (userId) => {
		game.calls.push(['grantConsent', userId]);
		return { ok: false, message: 'There is no Plex account link waiting for you.' };
	};
	buttons._use({ game });
	const i = await press(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER);
	assert.deepStrictEqual(i.calls.map((c) => c[0]), ['deferUpdate', 'followUp']);
	assert.deepStrictEqual(i.calls[1][1], { content: 'There is no Plex account link waiting for you.', flags: EPHEMERAL, allowedMentions: NO_PINGS });
});

test('a click Discord will not take an answer for is still claimed', async () => {
	const token = buttons.register({ userId: ASKER, pages: pagesOf(2) });
	const i = click(`apmedia:page:${token}:1`, ASKER, { async update() { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); } });
	assert.strictEqual(await buttons.handle(i, null, null, {}), true);
	const game = fakeGame(pending());
	buttons._use({ game });
	const c = click(`apmedia:consent:${buttons.consentToken(ASKER, T0)}`, ASKER, { async deferUpdate() { throw new Error('Unknown interaction'); } });
	assert.strictEqual(await buttons.handle(c, null, null, {}), true);
	assert.ok(!game.calls.some((x) => x[0] === 'grantConsent'), 'no grant on a click that could not be acknowledged');
});
