// commands/apmedia.js/common.js: what the /apmedia subcommands share: the strict owner gate,
// reading a slash option or the prefix text, picking the slot a command means, and how slot names
// and titles are written into a reply.
//
// Slot names come from players' YAML and titles from the Plex library or a hand-edited YAML, so
// both reach a reply as text nobody here wrote: a slot name goes in an inline code span (a backtick
// inside it would end the span early, so it becomes a quote; a command to type keeps it, inside a
// longer fence), a title through the game's escapeText (escapeMarkdown, masked links included).

const config = require('../../config/config.js');

const NO_PINGS = Object.freeze({ parse: [] });
const CONTENT_MAX = 2000;
const MENTION = /<@!?(\d{15,25})>/g;
const QUOTES = '"\u201C\u201D\u201E';
const QUOTE = new RegExp(`[${QUOTES}]`);
const KEY_VALUE = new RegExp(`(^|\\s)([A-Za-z][\\w-]*)=(?:[${QUOTES}]([^${QUOTES}]*)[${QUOTES}]?|(\\S*))`, 'g');

function prefixOf(bot) {
	return (bot && bot.config && bot.config.commandPrefix) || config.commandPrefix || '!';
}

function ownerId() {
	return String(config.ownerId || '').trim();
}

function isOwner(userId) {
	const owner = ownerId();
	return !!owner && String(userId) === owner;
}

/**
 * The strict owner gate: with ownerId blank nobody passes, because these read Plex accounts, hand
 * out the world file or act for somebody else.
 * @param {string} what the action, as in "Only the bot owner can <what>."
 * @returns {string|null} the refusal, or null to go on
 */
function ownerOnly(ctx, what) {
	if (!ownerId()) return `\u26D4 Only the bot owner can ${what}, and no owner is set yet: set ownerId first (\`${ctx.p}config\` \u2192 Access).`;
	if (!isOwner(ctx.userId)) return `\u26D4 Only the bot owner can ${what}.`;
	return null;
}

function slot(name) {
	return `\`${String(name ?? '').replace(/`/g, "'")}\``;
}

function esc(text) {
	return require('../../helpers/apMediaGame.js').escapeText(text);
}

function bold(text) {
	return `**${esc(text)}**`;
}

/** A command or code to type, in inline code and exact: slot() would turn a backtick into a quote. */
function commandCode(text) {
	return require('../../helpers/apMediaGame.js').commandCode(text);
}

/**
 * The code of a failed Plex read (UNREACHABLE, TIMEOUT, HTTP_401...), the one part of it a reply
 * may show: the message names the Plex host and port, and prefix replies are public.
 * @returns {string|null} null when err is no Plex read failure
 */
function plexCode(err) {
	return err && err.name === 'PmsError' && err.code ? String(err.code) : null;
}

function isSlash(ctx) {
	const i = ctx.interaction;
	return !!(i && i.options && typeof i.options.get === 'function');
}

/** A slash option's value, or undefined (also on the prefix path). */
function opt(ctx, name) {
	if (!isSlash(ctx)) return undefined;
	const got = ctx.interaction.options.get(name);
	return got && got.value !== undefined && got.value !== null ? got.value : undefined;
}

/** A USER option as the User object, or null. */
function optUser(ctx, name) {
	if (!isSlash(ctx) || typeof ctx.interaction.options.getUser !== 'function') return null;
	try {
		return ctx.interaction.options.getUser(name) || null;
	} catch (_) {
		return null;
	}
}

function normKey(key) {
	return String(key || '').toLowerCase().replace(/[-_]/g, '');
}

/** Discord mentions in prefix text: their ids, and the text without them. */
function takeMentions(text) {
	const ids = [];
	const rest = String(text || '').replace(MENTION, (whole, id) => {
		ids.push(id);
		return ' ';
	});
	return { ids, rest: rest.replace(/\s+/g, ' ').trim() };
}

/**
 * Pull `key=value` and `key="a value"` out of prefix text, for the keys asked for only, so a title
 * with an "=" in it stays whole. Keys match without case, dashes or underscores.
 * @param {string[]} keys normalised keys, e.g. ['slot', 'watch']
 * @returns {{values: Object<string, string>, rest: string}}
 */
function takeKeys(text, keys) {
	const values = {};
	const rest = String(text || '').replace(KEY_VALUE, (whole, lead, key, quoted, plain) => {
		const k = normKey(key);
		if (!keys.includes(k)) return whole;
		values[k] = quoted !== undefined ? quoted : plain;
		return lead;
	});
	return { values, rest: rest.replace(/\s+/g, ' ').trim() };
}

/**
 * Split prefix text into words, keeping a double-quoted stretch ("...", or the curly quotes a
 * phone types) together with its quotes removed. A word that starts `key=` is a pair.
 * @returns {{key: string|null, value: string, raw: string}[]}
 */
function tokenize(text) {
	const s = String(text || '');
	const out = [];
	let i = 0;
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i])) i += 1;
		if (i >= s.length) break;
		const start = i;
		let value = '';
		while (i < s.length && !/\s/.test(s[i])) {
			if (QUOTE.test(s[i])) {
				i += 1;
				while (i < s.length && !QUOTE.test(s[i])) {
					value += s[i];
					i += 1;
				}
				i += 1;
			} else {
				value += s[i];
				i += 1;
			}
		}
		const raw = s.slice(start, Math.min(i, s.length));
		const pair = /^([A-Za-z][\w-]*)=/.exec(raw);
		out.push(pair ? { key: pair[1], value: value.slice(pair[1].length + 1), raw } : { key: null, value, raw });
	}
	return out;
}

/**
 * The binding a command means: a slot name or binding key among the caller's own bindings, or
 * among every binding when `others` is allowed and the caller is the owner. Empty text picks the
 * caller's only binding, the owner's too: their friends' slots would make it ambiguous.
 */
function slotFor(ctx, text, { others = false } = {}) {
	const typed = typeof text === 'string' ? text.trim() : '';
	const all = !!typed && others === true && isOwner(ctx.userId);
	const r = ctx.game.resolveBinding(typed, { userId: ctx.userId, all });
	if (r.ok || typed || (r.candidates && r.candidates.length)) return r;
	return {
		ok: false,
		message: `${r.message} Once your seed is up, claim your slot with \`${ctx.p}ap claim <slot>\`, then \`/apmedia link <slot>\`.`,
	};
}

// --- titles --------------------------------------------------------------------------------

function damerau(a, b) {
	return require('../../helpers/bookSearch.js').damerau(a, b);
}

function normTitle(text) {
	return require('../../helpers/apMediaCredit.js').normTitle(text);
}

const NEAR = 0.34;
// A suggestion costs an edit distance against every title on the list, on the main thread, and a
// list can hold 2,000 titles: a text longer than this is no typo of one.
const SUGGEST_MAX = 200;

// 0 is the same title; under about a third is a typo away; Infinity is unrelated.
function closeness(query, label) {
	return closenessOf(normTitle(query), normTitle(label));
}

// An edit distance is at least the difference in length, so a pair further apart than that is
// never scored.
function closenessOf(a, b) {
	if (!a || !b) return Infinity;
	const longest = Math.max(a.length, b.length);
	const whole = Math.abs(a.length - b.length) > NEAR * longest ? Infinity : damerau(a, b) / longest;
	const theirs = b.split(' ');
	let edits = 0;
	let missed = false;
	for (const word of a.split(' ')) {
		const allowed = word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
		let best = Infinity;
		for (const t of theirs) {
			if (Math.abs(word.length - t.length) > allowed) continue;
			best = Math.min(best, damerau(word, t));
		}
		if (best > allowed) {
			missed = true;
			break;
		}
		edits += best;
	}
	return Math.min(whole, missed ? Infinity : edits / a.length);
}

/** Up to three list titles a typed title is probably meant to be. */
function didYouMean(query, labels, max = 3) {
	const a = normTitle(query);
	if (!a || a.length > SUGGEST_MAX) return [];
	return [...new Set(labels)]
		.map((label) => ({ label, score: closenessOf(a, normTitle(label)) }))
		.filter((x) => x.score <= NEAR)
		.sort((x, y) => x.score - y.score)
		.slice(0, max)
		.map((x) => x.label);
}

function allRows(game, key) {
	const rows = [];
	for (const which of ['ready', 'locked', 'done']) {
		const res = game.list(key, which);
		if (!res || !res.ok) return rows;
		for (const group of res.groups) rows.push(...group.rows);
	}
	return rows;
}

// Two copies of one film can share a title and a year. The game takes a title's ref (its entry key)
// as typed, so the copies are told apart by that.
function apart(ctx, key, found) {
	const labels = found.candidates;
	if (new Set(labels).size === labels.length) return found;
	let rows = [];
	try {
		rows = allRows(ctx.game, key).filter((row) => labels.includes(row.title) && row.ref);
	} catch (_) {}
	if (!rows.length) return found;
	const shown = rows.slice(0, 5).map((row) => `${bold(row.title)} ${commandCode(row.ref)}`);
	return { ok: false, message: `Several titles match: ${shown.join(', ')}. Give the one you mean by the code after it.`, candidates: labels };
}

// "Matrix" names The Matrix (1999) as surely as "The Matrix" does.
const ARTICLE = /^(?:the|a|an) /;

function bare(text) {
	return normTitle(text).replace(ARTICLE, '');
}

/**
 * Whether the text names the game's hit in full: its code (`#n` or the entry key), or its whole
 * title with or without the year, a leading article, and an album's artist or a book's author.
 * The game also takes any part of a title, and "Alien" is a part of "Aliens (1986)".
 */
function namesInFull(text, found) {
	const raw = String(text ?? '').trim();
	if (/^#\d+$/.test(raw) || raw === found.entryKey) return true;
	const want = bare(raw);
	if (!want) return false;
	const names = [found.title];
	// An episode's own title ("Pilot") names no episode in particular; the game skips it too.
	if (found.entry && found.entry.k !== 'episode') names.push(found.entry.t);
	return names.some((name) => typeof name === 'string' && bare(name) === want);
}

/** The list title a text names in full, or null: no near misses, so it is cheap to try first. */
function exactTitle(ctx, key, text) {
	const found = ctx.game.findEntry(key, text);
	return found.ok && namesInFull(text, found) ? found : null;
}

/**
 * A list title from what somebody typed, named in full; anything less is answered with the title
 * it is probably meant to be, as a question. A guess is never taken on its own: a check sent for the
 * wrong title, or a Wild Ticket spent on it, cannot be taken back.
 */
function findTitle(ctx, key, text) {
	const found = ctx.game.findEntry(key, text);
	if (found.ok) {
		if (namesInFull(text, found)) return found;
		return { ok: false, message: `Did you mean ${bold(found.title)}? Type its title in full, or give its code: ${commandCode(found.entryKey)}.` };
	}
	if (found.candidates && found.candidates.length) return apart(ctx, key, found);
	if (normTitle(text).length > SUGGEST_MAX) return found;
	let near = [];
	try {
		near = didYouMean(text, allRows(ctx.game, key).map((row) => row.title));
	} catch (_) {}
	if (!near.length) return found;
	return { ok: false, message: `${found.message} Did you mean ${near.map(bold).join(', ')}?` };
}

function ordinal(n) {
	const v = Math.abs(Math.trunc(n)) % 100;
	const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] || 'th';
	return `${n}${suffix}`;
}

function plural(n, word, many = `${word}s`) {
	return `${n} ${n === 1 ? word : many}`;
}

/**
 * Lines into pages that each fit a message: a block (a heading and its rows) is never split from
 * its heading, and one too long for a page is continued under its heading again.
 * @param {string[]} head repeated at the top of every page
 * @param {{title: string|null, rows: string[]}[]} blocks
 * @param {{budget?: number, maxRows?: number}} [opts]
 * @returns {string[]}
 */
function paginate(head, blocks, { budget = 1850, maxRows = 22 } = {}) {
	const top = head.join('\n');
	const pages = [];
	let lines = [];
	let size = top.length;
	let rows = 0;
	const flush = () => {
		if (lines.length) pages.push([top, ...lines].join('\n'));
		lines = [];
		size = top.length;
		rows = 0;
	};
	const add = (line, isRow) => {
		lines.push(line);
		size += line.length + 1;
		if (isRow) rows += 1;
	};
	for (const block of blocks) {
		const title = block.title;
		const fits = (line, extra = 0) => size + line.length + 1 + extra <= budget && (rows < maxRows);
		if (title && lines.length && !fits(title, (block.rows[0] || '').length + 1)) flush();
		if (title) add(title, false);
		for (const rowLine of block.rows) {
			// With no row on the page yet, a flush would leave a page of headings alone.
			if (!fits(rowLine) && rows > 0) {
				flush();
				if (title) add(`${title} (continued)`, false);
			}
			add(rowLine.length > budget - top.length - 40 ? `${cut(rowLine, budget - top.length - 41)}\u2026` : rowLine, true);
		}
	}
	flush();
	if (!pages.length) pages.push(top);
	if (pages.length > 1) return pages.map((page, i) => fit(page, `\nPage ${i + 1} of ${pages.length}`));
	return pages.map((page) => fit(page, ''));
}

// The budget above leaves room for the footer, but a long heading repeated as "(continued)" over a
// long row can still pass it, and Discord refuses the whole message then; a page turn included.
function fit(page, footer) {
	if (page.length + footer.length <= CONTENT_MAX) return `${page}${footer}`;
	return `${cut(page, CONTENT_MAX - footer.length - 1)}\u2026${footer}`;
}

// A cut between the halves of a surrogate pair would leave half an emoji.
function cut(text, length) {
	const out = text.slice(0, Math.max(0, length));
	const last = out.charCodeAt(out.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}

/** One reply of pages: the first now, the rest behind the page buttons for the asker only. */
function sendPages(ctx, pages) {
	const payload = ctx.buttons.firstPage({ userId: ctx.userId, pages });
	return ctx.say(payload.components.length ? payload : payload.content);
}

module.exports = {
	NO_PINGS,
	prefixOf,
	ownerId,
	isOwner,
	ownerOnly,
	slot,
	esc,
	bold,
	commandCode,
	plexCode,
	isSlash,
	opt,
	optUser,
	normKey,
	takeMentions,
	takeKeys,
	tokenize,
	slotFor,
	closeness,
	didYouMean,
	namesInFull,
	exactTitle,
	findTitle,
	ordinal,
	plural,
	paginate,
	sendPages,
};
