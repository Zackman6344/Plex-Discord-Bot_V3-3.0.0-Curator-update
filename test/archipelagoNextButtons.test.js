// helpers/archipelagoNextButtons.js: the ◀ ▶ page buttons on a one-slot `!ap next` reply.
//
// What can go wrong: a button pointing at the wrong page, somebody else turning the asker's pages,
// a click on a list the bot no longer keeps going unanswered ("This interaction failed"), a page
// that pings the people it names, a page number off the end, and the kept lists outliving the
// half hour since their last use or growing past 50.
//
// Harness: the helper on its own with recording fake interactions. Date comes from
// t.mock.timers where time matters.

const test = require('node:test');
const assert = require('node:assert');

const logger = require('../helpers/logger.js');
const nb = require('../helpers/archipelagoNextButtons.js');

const T0 = 1791500000000;
const MIN = 60 * 1000;
const ASKER = '100000000000000001';
const OTHER = '100000000000000002';
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };

test.beforeEach(() => nb._lists.clear());

function pagesOf(n) {
	return Array.from({ length: n }, (_, i) => `Page ${i + 1} of ${n}: Lost Woods Chest for <@${OTHER}> @everyone`);
}

function click(customId, userId = ASKER) {
	const calls = [];
	return {
		customId,
		user: { id: userId },
		calls,
		async update(p) { calls.push(['update', p]); },
		async reply(p) { calls.push(['reply', p]); }
	};
}

async function press(customId, userId = ASKER, opts) {
	const i = click(customId, userId);
	assert.strictEqual(await nb.handle(i, null, null, opts), true, `${customId} was not claimed`);
	return i;
}

function only(i, kind) {
	assert.deepStrictEqual(i.calls.map(c => c[0]), [kind]);
	return i.calls[0][1];
}

// The helper hands Discord builders, and toJSON is what goes over the wire.
function buttons(components) {
	return components
		.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r))
		.flatMap(r => r.components)
		.map(b => ({ id: b.custom_id, label: b.label, disabled: Boolean(b.disabled) }));
}

test('every list gets its own token, even several in one millisecond, and its buttons carry the token back intact', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: T0 });
	const tokens = Array.from({ length: 25 }, () => nb.register({ userId: ASKER, pages: pagesOf(2) }));
	assert.strictEqual(new Set(tokens).size, tokens.length);
	for (const token of tokens) {
		for (const b of buttons([nb.row(token, 0, 2)])) assert.strictEqual(b.id.split(':')[1], token, b.id);
	}
});

test('each button carries the page it turns to, and the way off either end is greyed out', () => {
	const at = (page, total) => {
		const [back, fwd] = buttons([nb.row('tok', page, total)]);
		assert.deepStrictEqual([back.label, fwd.label], ['◀', '▶']);
		// Discord refuses a message whose components share a custom id.
		assert.notStrictEqual(back.id, fwd.id);
		return { back, fwd };
	};
	const first = at(0, 3);
	assert.strictEqual(first.back.disabled, true);
	assert.deepStrictEqual(first.fwd, { id: 'apnext:tok:1', label: '▶', disabled: false });
	const middle = at(1, 3);
	assert.deepStrictEqual(middle.back, { id: 'apnext:tok:0', label: '◀', disabled: false });
	assert.deepStrictEqual(middle.fwd, { id: 'apnext:tok:2', label: '▶', disabled: false });
	const last = at(2, 3);
	assert.deepStrictEqual(last.back, { id: 'apnext:tok:1', label: '◀', disabled: false });
	assert.strictEqual(last.fwd.disabled, true);
	const alone = at(0, 1);
	assert.deepStrictEqual([alone.back.disabled, alone.fwd.disabled], [true, true]);
});

test('clicks meant for other buttons are left for the next handler', async () => {
	const seen = [];
	for (const id of ['book:fwd:abc', 'playback:skip', 'tagprop:next:none:0', 'apnextx:abc:1', 'apnext', undefined]) {
		const i = click(id);
		assert.strictEqual(await nb.handle(i, null, null, { onInteractionResponse: p => seen.push(p) }), false, String(id));
		assert.deepStrictEqual(i.calls, [], `${id} was answered`);
	}
	assert.deepStrictEqual(seen, []);
});

test('a click on a list the bot no longer keeps is answered privately that it has expired', async () => {
	const r = only(await press('apnext:neverissued:1'), 'reply');
	assert.match(r.content, /expired/i);
	assert.strictEqual(r.flags, EPHEMERAL);
	assert.deepStrictEqual(r.allowedMentions, NO_PINGS);
});

test('somebody other than the asker is refused privately, and the pages still turn for the asker', async () => {
	const pages = pagesOf(3);
	const token = nb.register({ userId: ASKER, pages });
	const r = only(await press(`apnext:${token}:1`, OTHER), 'reply');
	assert.match(r.content, /only the person who asked/i);
	assert.strictEqual(r.flags, EPHEMERAL);
	assert.deepStrictEqual(r.allowedMentions, NO_PINGS);
	assert.strictEqual(only(await press(`apnext:${token}:1`), 'update').content, pages[1]);
});

test('the buttons walk the whole list forward and back, each click replacing the message without pinging anyone', async () => {
	const pages = pagesOf(4);
	const token = nb.register({ userId: ASKER, pages });
	let row = buttons([nb.row(token, 0, pages.length)]);
	const shown = [];
	const open = (label) => !row.find(b => b.label === label).disabled;
	const follow = async (label) => {
		const p = only(await press(row.find(b => b.label === label).id), 'update');
		assert.deepStrictEqual(p.allowedMentions, NO_PINGS);
		assert.strictEqual(p.components.length, 1);
		row = buttons(p.components);
		shown.push(p.content);
	};
	for (let n = 0; n < 10 && open('▶'); n++) await follow('▶');
	assert.deepStrictEqual(shown, pages.slice(1));
	shown.length = 0;
	for (let n = 0; n < 10 && open('◀'); n++) await follow('◀');
	assert.deepStrictEqual(shown, pages.slice(0, -1).reverse());
});

test('a page number off either end, or not a number at all, shows the nearest real page', async () => {
	const pages = pagesOf(3);
	const token = nb.register({ userId: ASKER, pages });
	const cases = [[':-1', 0], [':-7', 0], [':3', 2], [':99', 2], [':abc', 0], [':', 0], ['', 0]];
	for (const [suffix, want] of cases) {
		const p = only(await press(`apnext:${token}${suffix}`), 'update');
		assert.strictEqual(p.content, pages[want], `apnext:<token>${suffix}`);
		const [back, fwd] = buttons(p.components);
		assert.deepStrictEqual([back.disabled, fwd.disabled], [want === 0, want === pages.length - 1], `buttons after apnext:<token>${suffix}`);
	}
});

test('the command log sees every answer, and an observer that throws does not stop the page turning', async () => {
	const pages = pagesOf(3);
	const token = nb.register({ userId: ASKER, pages });
	const seen = [];
	const watch = { onInteractionResponse: p => seen.push(p) };
	const turned = await press(`apnext:${token}:1`, ASKER, watch);
	const refused = await press(`apnext:${token}:2`, OTHER, watch);
	const expired = await press('apnext:neverissued:1', ASKER, watch);
	assert.deepStrictEqual(seen, [only(turned, 'update'), only(refused, 'reply'), only(expired, 'reply')]);
	const broken = { onInteractionResponse() { throw new Error('command log unavailable'); } };
	assert.strictEqual(only(await press(`apnext:${token}:2`, ASKER, broken), 'update').content, pages[2]);
});

// An unclaimed click goes on to the next handler in app/music.js, and a throw is logged there as
// the whole button failing. A rejected answer should be neither, only a warning in the log.
test('a click Discord will not take an answer for is still claimed, and the failure is logged', async (t) => {
	const warn = t.mock.method(logger, 'warn', () => {});
	const token = nb.register({ userId: ASKER, pages: pagesOf(2) });
	const rejected = (customId, userId) => {
		const i = click(customId, userId);
		i.update = i.reply = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
		return i;
	};
	for (const i of [rejected(`apnext:${token}:1`, ASKER), rejected(`apnext:${token}:1`, OTHER), rejected('apnext:neverissued:1', ASKER)]) {
		assert.strictEqual(await nb.handle(i, null, null), true, i.customId);
	}
	assert.strictEqual(warn.mock.callCount(), 3);
});

// Another asker's list is registered before each look, so this holds whether the helper drops
// stale lists when one is registered or when a click arrives.
test('a list is kept for the full time again after each page turn, while an untouched one expires', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: T0 });
	const ttl = nb._ttlMs;
	const pages = pagesOf(3);
	const turned = nb.register({ userId: ASKER, pages });
	const untouched = nb.register({ userId: ASKER, pages });
	t.mock.timers.tick(ttl * 2 / 3);
	await press(`apnext:${turned}:1`);
	t.mock.timers.tick(ttl * 2 / 3);
	nb.register({ userId: OTHER, pages });
	assert.match(only(await press(`apnext:${untouched}:1`), 'reply').content, /expired/i, 'untouched since it was asked for');
	assert.strictEqual(only(await press(`apnext:${turned}:2`), 'update').content, pages[2], 'as old, but turned since');
	t.mock.timers.tick(ttl + MIN);
	nb.register({ userId: OTHER, pages });
	assert.match(only(await press(`apnext:${turned}:1`), 'reply').content, /expired/i, 'not turned since its last turn');
});

// The pages are what was in logic when the command ran. Expiry is what stops an hours-old list
// passing for what is in logic now, so it cannot wait for somebody to ask for another list.
test('a list left alone past its time has expired even when nobody has asked for another since', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: T0 });
	const token = nb.register({ userId: ASKER, pages: pagesOf(3) });
	t.mock.timers.tick(nb._ttlMs + MIN);
	const r = only(await press(`apnext:${token}:1`), 'reply');
	assert.match(r.content, /expired/i);
	assert.strictEqual(r.flags, EPHEMERAL);
});

test('past the cap the list used longest ago goes first, and a page turn counts as a use', async () => {
	const pages = pagesOf(2);
	const older = nb.register({ userId: ASKER, pages });
	const newer = nb.register({ userId: ASKER, pages });
	await press(`apnext:${older}:1`);
	for (let n = 0; n < 200 && nb._lists.has(newer); n++) nb.register({ userId: OTHER, pages });
	assert.ok(!nb._lists.has(newer), 'the list used longest ago is dropped once the cap is passed');
	assert.ok(nb._lists.has(older), 'registered earlier, but turned since');
	nb.register({ userId: OTHER, pages });
	assert.ok(!nb._lists.has(older), 'now the list used longest ago');
	assert.match(only(await press(`apnext:${newer}:1`), 'reply').content, /expired/i);
});

test('no more than 50 lists are kept at once, and the 50 kept are the newest', () => {
	const tokens = [];
	for (let n = 1; n <= 60; n++) {
		tokens.push(nb.register({ userId: ASKER, pages: pagesOf(2) }));
		assert.ok(nb._lists.size <= 50, `${nb._lists.size} lists kept after ${n} were asked for`);
	}
	assert.deepStrictEqual([...nb._lists.keys()], tokens.slice(-50));
});
