// /apmedia snackbar: your slot's Snack Bar. Without buy it shows the snacks held, the price of a
// trade and the trades left; with buy it trades snacks for a Fast Forward or a Remote Control. Only
// the bound player trades.
//
//   !apmedia snackbar                        the terms
//   !apmedia snackbar buy fast-forward       one trade (fast forward, ff, remote control and rc work too)
//   !apmedia snackbar rc slot=Zack           on one of several slots; slot="Zack 2" for a name with a space
//   !apmedia snackbar slot=Zack buy rc       the same with slot= first

const common = require('./common.js');

// Words without case, dashes, underscores or spaces, to what the game buys.
const ITEMS = Object.freeze({
	fastforward: 'fastForward',
	ff: 'fastForward',
	remotecontrol: 'remoteControl',
	remote: 'remoteControl',
	rc: 'remoteControl',
});

function itemOf(word) {
	const key = String(word ?? '').toLowerCase().replace(/[-_\s]/g, '');
	return Object.prototype.hasOwnProperty.call(ITEMS, key) ? ITEMS[key] : null;
}

/**
 * How many of the first words name an item: its own two-word name before one word, 0 for none.
 * Given ctx, "remote" before the name of one of the caller's slots is the item alone: with a slot
 * `Control Freak`, "remote Control Freak" is a Remote Control for it.
 */
function itemLength(words, ctx = null) {
	if (words.length >= 2 && itemOf(`${words[0]} ${words[1]}`) && !(ctx && itemOf(words[0]) && ownSlot(ctx, words.slice(1).join(' ')))) return 2;
	return words.length && itemOf(words[0]) ? 1 : 0;
}

/** How many of the words after a leading slot= the command reads: buy and the item after it, or an item. */
function ownWords(words) {
	if (!words.length || words[0].toLowerCase() !== 'buy') return itemLength(words);
	return words.length > 1 ? 1 + Math.max(1, itemLength(words.slice(1))) : 1;
}

function ownSlot(ctx, text) {
	return common.namesSlot(ctx, text, { others: false });
}

/** buy: the item, null for none, or undefined for a word that names no item. */
function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const buy = common.opt(ctx, 'buy');
		return { buy: buy === undefined ? null : (itemOf(buy) || undefined), word: buy, slot: String(common.opt(ctx, 'slot') ?? '').trim() };
	}
	const { values, rest } = common.takeKeys(ctx.rest, ['slot', 'buy']);
	const problem = common.slotTail(ctx.rest, { keys: ['buy'], own: (words) => (values.buy === undefined ? ownWords(words) : 0) });
	if (problem) return { problem };
	// With slot= no word after the item is a slot, so none keeps a two-word name to its first word.
	const asks = values.slot === undefined ? ctx : null;
	const words = rest.split(/\s+/).filter(Boolean);
	let word = values.buy;
	if (word === undefined && words.length && words[0].toLowerCase() === 'buy') {
		words.shift();
		word = words.splice(0, Math.max(1, itemLength(words, asks))).join(' ');
	} else if (word === undefined && itemLength(words, asks) && (values.slot !== undefined || !ownSlot(ctx, words.join(' ')))) {
		// Without buy, text that names one of your slots is that slot: a slot named RC shows its bar.
		word = words.splice(0, itemLength(words, asks)).join(' ');
	}
	const slot = values.slot !== undefined ? values.slot : words.join(' ');
	if (word === undefined) return { buy: null, word, slot };
	return { buy: itemOf(word) || undefined, word, slot };
}

async function run(ctx) {
	const input = readInput(ctx);
	if (input.problem) return ctx.say(input.problem);
	if (input.buy === undefined) {
		const said = input.word ? `${common.slot(input.word)} is not on the menu. ` : '';
		return ctx.say(`${said}The Snack Bar sells \`fast-forward\` and \`remote-control\`: \`${ctx.p}apmedia snackbar buy fast-forward\`.`);
	}
	const r = common.slotFor(ctx, input.slot, { others: false });
	if (!r.ok) return ctx.say(r.message);
	const out = await ctx.game.snackBar(r.key, { buy: input.buy });
	return ctx.say(out.message);
}

module.exports = { names: ['snackbar'], run, itemOf };
