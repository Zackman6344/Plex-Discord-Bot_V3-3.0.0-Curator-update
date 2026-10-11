// /book marks and /book unmark: the read-along's sync marks (helpers/bookTextStore.js marks).
//
// A mark is set with 📌 on the listener's DM page (helpers/readAlong.js) and is shared by everyone
// who plays that recording. These replies carry audio times, the audio's own chapter titles, who
// and when, and never a word of the book.
//
// Anyone removes their own marks; the bot owner may remove anyone's, and only the owner clears a
// whole book.

const config = require('../../config/config.js');
const bookModel = require('../../helpers/bookModel.js');
const { resolveMarks, recordingOf, sameRecording } = require('../../helpers/readAlongModel.js');

const LIST_MAX = 20;
// Discord cuts a message at 2000 characters and the cut takes the end, where the "…and N more"
// line and the unmark instructions are; the margin leaves room for escaped title characters.
const LIST_BUDGET = 1850;
const CHAPTER_MAX = 40;
const SAVE_FAILED = '❌ The marks file could not be written; check the bot log.';

function esc(text) {
	return String(text === null || text === undefined ? '' : text).replace(/([\\*_`~|])/g, '\\$1');
}

function prefix() {
	return config.commandPrefix || '!';
}

function textStore() {
	return require('../../helpers/bookTextStore.js');
}

function catalogStore() {
	return require('../../helpers/bookCatalogStore.js');
}

function norm(text) {
	return require('../../helpers/bookCatalog.js').norm(text);
}

function ownerId() {
	return String(config.ownerId || '').trim();
}

function isOwner(userId) {
	return !!ownerId() && String(userId) === ownerId();
}

function shortDate(ms) {
	const d = new Date(ms);
	return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}`;
}

// Marks belong to a narration, so the edition is part of the name.
function nameOf(work) {
	const suffix = work.edition ? ` (${work.edition})` : work.narrator ? ` (read by ${work.narrator})` : '';
	return `**${esc(work.title || work.id)}**${esc(suffix)}`;
}

// The book you are playing, else the one playing in this server.
function playingWork(ctx) {
	const books = ctx.bot.books;
	let s = null;
	try {
		s = (books.sessions() || []).find(x => String(x.userId) === String(ctx.userId) && x.state !== 'ended') || null;
	} catch (_) {}
	if (!s && ctx.guildId && typeof books.session === 'function') {
		try { s = books.session(ctx.guildId) || null; } catch (_) {}
	}
	if (!s) return null;
	let cur = null;
	try { cur = catalogStore().work(s.workId); } catch (_) {}
	return cur || s.work || null;
}

function workFor(ctx, titleText, usage) {
	const q = String(titleText || '').trim();
	if (q) {
		const found = ctx.resolveWork(q, ctx.userId);
		if (found.error) return { error: found.error };
		return { work: found.work || { id: found.id, title: found.title, aliases: [] } };
	}
	const w = playingWork(ctx);
	return w ? { work: w } : { error: `Which book? ${usage}, or run it while the book plays.` };
}

function chapterOf(work, ms) {
	try {
		const ch = bookModel.chapterAt(work, ms);
		return ch && ch.title ? String(ch.title) : '';
	} catch (_) {
		return '';
	}
}

/**
 * Which listed marks the map leaves out, and why: the ebook text changed, the mark was made against
 * another recording filed under this id, or a newer mark disagrees.
 */
function unusedOf(work, list) {
	let ptr = null;
	try { ptr = textStore().works.peek(work); } catch (_) {}
	const base = ptr && ptr.base ? ptr.base : null;
	const rec = recordingOf(work);
	const out = new Map();
	const byText = new Map();
	for (const m of list) {
		if (base && m.text !== base) {
			out.set(m.id, 'old ebook text');
			continue;
		}
		if (!sameRecording(m.rec, rec)) {
			out.set(m.id, 'another recording');
			continue;
		}
		if (!byText.has(m.text)) byText.set(m.text, []);
		byText.get(m.text).push(m);
	}
	for (const group of byText.values()) {
		for (const m of resolveMarks(group).overruled) out.set(m.id, 'a newer mark disagrees');
	}
	return out;
}

function clip(text, max) {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function lineOf(work, m, i, unused) {
	const ch = chapterOf(work, m.ms);
	const bits = [bookModel.formatClock(m.ms, true)];
	if (ch) bits.push(esc(clip(ch, CHAPTER_MAX)));
	bits.push(m.by ? `<@${m.by}>` : 'someone');
	if (m.at) bits.push(shortDate(m.at));
	if (unused.has(m.id)) bits.push(`not used (${unused.get(m.id)})`);
	return `${i + 1}. ${bits.join(' · ')}`;
}

function changed(ctx, work) {
	const ra = ctx.bot.readAlong;
	if (ra && typeof ra.marksChanged === 'function') {
		try { ra.marksChanged(work); } catch (_) {}
	}
}

async function marks(ctx) {
	const p = prefix();
	const found = workFor(ctx, ctx.rest, `\`${p}book marks <title>\``);
	if (found.error) return ctx.say(found.error);
	const work = found.work;
	const list = textStore().marks.list(work);
	if (!list.length) {
		return ctx.say(`📌 ${nameOf(work)} has no sync marks yet. On your DM page (\`${p}book text on\`), press 📌 when the narrator reaches the page's first words.`);
	}
	const unused = unusedOf(work, list);
	const head = `📌 ${nameOf(work)}: ${list.length} sync mark${list.length === 1 ? '' : 's'}, shared by everyone who plays this recording.`;
	const clear = isOwner(ctx.userId) ? `, \`${p}book unmark all <title> confirm\` clears them all` : '';
	const foot = `\`${p}book unmark\` removes your latest mark, \`${p}book unmark <n>\` one of yours from this list${clear}.`;
	const more = (n) => `…and ${n} more.`;
	const lines = [];
	let used = head.length + foot.length + more(list.length).length + 3;
	for (let i = 0; i < Math.min(list.length, LIST_MAX); i++) {
		const line = lineOf(work, list[i], i, unused);
		if (used + line.length + 1 > LIST_BUDGET) break;
		lines.push(line);
		used += line.length + 1;
	}
	const out = [head, ...lines];
	if (list.length > lines.length) out.push(more(list.length - lines.length));
	out.push(foot);
	return ctx.say(out.join('\n'));
}

/** `unmark`, `unmark 3 [title]`, `unmark all [title] [confirm]` or `unmark <title>`. */
function parseUnmark(rest) {
	const text = String(rest || '').trim();
	const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!m) return { kind: 'latest', title: '' };
	const tail = (m[2] || '').trim();
	if (m[1].toLowerCase() === 'all') {
		// The prefix form puts confirm last; the slash form's `which:all confirm` puts it first.
		const c = /^confirm(?:\s+([\s\S]*))?$/i.exec(tail) || /^([\s\S]*?)\s+confirm$/i.exec(tail);
		return c ? { kind: 'all', title: (c[1] || '').trim(), confirm: true } : { kind: 'all', title: tail, confirm: false };
	}
	if (/^\d{1,4}$/.test(m[1])) return { kind: 'n', n: Number(m[1]), title: tail };
	return { kind: 'latest', title: text };
}

// The work whose title is exactly this text, so "All Systems Red" or "1984" is a book, not the
// keyword it starts with.
function titled(ctx, text) {
	const q = String(text || '').trim();
	if (!q) return null;
	let found = null;
	try { found = ctx.resolveWork(q, ctx.userId); } catch (_) {}
	const w = found && !found.error ? found.work : null;
	return w && norm(w.title) === norm(q) ? w : null;
}

// A number reads as a mark of the book it names, unless that book has no such mark and the
// whole text is another book's title.
function readUnmark(ctx) {
	const args = parseUnmark(ctx.rest);
	if (args.kind === 'latest' || !titled(ctx, ctx.rest)) return args;
	const latest = { kind: 'latest', title: String(ctx.rest).trim() };
	if (args.kind === 'all') return latest;
	const found = workFor(ctx, args.title, '');
	const count = found.work ? textStore().marks.list(found.work).length : 0;
	return args.n <= count ? args : latest;
}

async function unmark(ctx) {
	const p = prefix();
	const args = readUnmark(ctx);
	if (args.kind === 'all') {
		if (!ownerId()) return ctx.say(`⛔ Set ownerId first (\`${p}config\` → Access); clearing a book's marks is owner-only.`);
		if (!isOwner(ctx.userId)) return ctx.say(`⛔ Only the bot owner can clear all of a book's marks. \`${p}book unmark\` removes your own latest one.`);
	}
	const found = workFor(ctx, args.title, `\`${p}book unmark [n|all] <title>\``);
	if (found.error) return ctx.say(found.error);
	const work = found.work;
	const store = textStore().marks;
	const list = store.list(work);
	if (args.kind === 'all') {
		if (!list.length) return ctx.say(`📌 ${nameOf(work)} has no marks to clear.`);
		if (!args.confirm) {
			const people = new Set(list.map(m => String(m.by))).size;
			const again = ctx.interaction
				? `/book unmark which:all confirm title:${work.id}`
				: `${p}book unmark all ${work.id} confirm`;
			return ctx.say(`📌 This clears all ${list.length} mark${list.length === 1 ? '' : 's'} of ${nameOf(work)}, set by ${people} listener${people === 1 ? '' : 's'}, for everyone who plays this recording. Run \`${again}\` to do it.`);
		}
		const r = store.clear(work);
		if (!r.ok) return ctx.say(SAVE_FAILED);
		changed(ctx, work);
		return ctx.say(`📌 Cleared all ${r.removed.length} mark${r.removed.length === 1 ? '' : 's'} of ${nameOf(work)}.`);
	}
	let target;
	if (args.kind === 'n') {
		target = list[args.n - 1];
		if (!target) {
			const range = list.length ? `1 to ${list.length}` : 'none';
			return ctx.say(`📌 ${nameOf(work)} has no mark ${args.n}; \`${p}book marks\` lists ${range}.`);
		}
		if (String(target.by) !== String(ctx.userId) && !isOwner(ctx.userId)) {
			return ctx.say(`⛔ Mark ${args.n} is <@${target.by}>'s; only they or the bot owner can remove it.`);
		}
	} else {
		target = list.filter(m => String(m.by) === String(ctx.userId)).sort((a, b) => b.at - a.at)[0];
		if (!target) return ctx.say(`📌 You have no marks on ${nameOf(work)}. \`${p}book marks\` lists them.`);
	}
	const r = store.remove(work, [target.id]);
	if (!r.ok) return ctx.say(SAVE_FAILED);
	changed(ctx, work);
	const ch = chapterOf(work, target.ms);
	return ctx.say(`📌 Removed the mark at ${bookModel.formatClock(target.ms, true)}${ch ? ` (${esc(ch)})` : ''} on ${nameOf(work)}.`);
}

async function run(ctx) {
	if (ctx.sub === 'unmark') return unmark(ctx);
	return marks(ctx);
}

module.exports = { names: ['marks', 'unmark'], run, parseUnmark };
