// /book text and /book link: the read-along (helpers/readAlong.js) and the owner's ebook links
// (helpers/bookTextSource.js).
//
// Nothing here ever replies with book text, and a reply anyone else could see never names a
// local path: on the prefix path in a guild channel `!book link <work>` answers with file names
// and Calibre ids only and sends the full paths to the owner by DM.
//
// `!book link` reads arbitrary files on this PC, so it needs a configured ownerId; unlike
// rescan there is no "anyone while ownerId is blank" bootstrap.

const config = require('../../config/config.js');
const logger = require('../../helpers/logger.js');
const { isbnForms } = require('../../helpers/bookTextSource.js');

const DM_CLOSED = 50007;
const LIST_MAX = 5;
const DM_MAX = 1990;

function esc(text) {
	return String(text === null || text === undefined ? '' : text).replace(/([\\*_`~|])/g, '\\$1');
}

function prefix() {
	return config.commandPrefix || '!';
}

function linkUsage(p = prefix()) {
	return `Usage: \`${p}book link <book> <ebook>\`, where the ebook is a Calibre id (\`id:299\`), an ISBN (\`isbn:9780765350381\`), ` +
		'the full path of an .epub file, `off` or `auto`. Quote a title that ends in a number: ' +
		`\`${p}book link "Fahrenheit 451" id:12\`. \`${p}book link <book>\` alone shows what it uses now.`;
}

/** @returns {string|null} the ISBN-13 form of an ISBN-10 (or of an ISBN-13), null if neither */
function isbn13(isbn) {
	const forms = isbnForms(isbn);
	return forms.length ? forms[0] : null;
}

function isPathText(text) {
	return /^([A-Za-z]:[\\/]|\\\\|\/\/|\/)/.test(text);
}

/**
 * One target, as typed. Bare numbers and bare ISBNs are returned with `explicit: false`: they are
 * only a reading for run() to weigh against a title that ends in a number.
 * @returns {{ target: object, explicit: boolean } | null}
 */
function targetOf(raw) {
	let text = String(raw || '').trim();
	if (/^".*"$/.test(text)) text = text.slice(1, -1).trim();
	if (!text) return null;
	const lower = text.toLowerCase();
	if (/^id:\d{1,9}$/i.test(text)) return { target: { type: 'calibre', id: Number(text.slice(3)) }, explicit: true };
	if (/^isbn:[\dXx-]{10,17}$/i.test(text)) return { target: { type: 'isbn', isbn: text.slice(5) }, explicit: true };
	if (lower === 'off' || lower === 'auto') return { target: { type: lower }, explicit: true };
	if (isPathText(text)) return { target: { type: 'file', path: text }, explicit: true };
	if (/^\d{1,7}$/.test(text)) return { target: { type: 'calibre', id: Number(text) }, explicit: false };
	if (/^[\d-]{9,16}[\dXx]$/.test(text) && [10, 13].includes(text.replace(/-/g, '').length)) {
		return { target: { type: 'isbn', isbn: text }, explicit: false };
	}
	return null;
}

/**
 * The readings of `!book link <rest>`, not a decision (run() resolves them against the catalog).
 * @returns {{ whole: string, quoted?: { workText, target }, split?: { workText, target, explicit } }}
 */
function parseLinkArgs(rest) {
	const text = String(rest || '').trim();
	const out = { whole: text };
	if (!text) return out;
	const q = /^"([^"]+)"\s+(.+)$/.exec(text);
	if (q) {
		const t = targetOf(q[2]);
		if (t) out.quoted = { workText: q[1].trim(), target: t.target };
		return out;
	}
	// A path runs to the end of the line and may hold spaces, so it starts at the first quote,
	// drive letter, UNC or // that follows a space. UNC forms are parsed only so the source can
	// refuse them by name.
	const path = /\s("|[A-Za-z]:[\\/]|\\\\|\/\/)/.exec(text);
	if (path) {
		const workText = text.slice(0, path.index).trim();
		const t = targetOf(text.slice(path.index));
		if (workText && t) {
			out.split = { workText, target: t.target, explicit: true };
			return out;
		}
	}
	const posix = /\s(\/(?!\/).*\.epub)$/i.exec(text);
	if (posix) {
		const workText = text.slice(0, posix.index).trim();
		if (workText) {
			out.split = { workText, target: { type: 'file', path: posix[1] }, explicit: true };
			return out;
		}
	}
	const m = /^(.*\S)\s+(\S+)$/.exec(text);
	if (!m) return out;
	const t = targetOf(m[2]);
	if (t && t.target.type !== 'file') out.split = { workText: m[1].trim(), target: t.target, explicit: t.explicit };
	return out;
}

function catalogStore() {
	return require('../../helpers/bookCatalogStore.js');
}

function norm(text) {
	return require('../../helpers/bookCatalog.js').norm(text);
}

/** A work named exactly (id, alias or the whole title), never a fuzzy match. */
function exactWork(q) {
	const text = String(q || '').trim();
	if (!text) return null;
	const store = catalogStore();
	const byId = store.work(text);
	if (byId) return byId;
	const hits = (store.works() || []).filter(w => norm(w.title) === norm(text));
	return hits.length === 1 ? hits[0] : null;
}

function statusText(st) {
	switch (st) {
		case 'ready': return 'text ready';
		case 'available': return 'an ebook was found, not read yet';
		case 'none': return 'no ebook found';
		case 'off': return 'read-along off';
		default: return 'not checked yet';
	}
}

function sourceText(src) {
	if (!src) return 'unknown';
	if (src.type === 'calibre') return `Calibre #${src.id}`;
	return esc(src.path || 'an EPUB');
}

/** The describe() report as Discord lines; paths only if describe() was asked for them. */
function formatDescribe(d, p = prefix()) {
	const lines = [`📜 **${esc(d.title || d.workId)}** (\`${d.workId}\`): ${statusText(d.status)}.`];
	const link = d.link;
	if (!link) lines.push('🔗 No link: found automatically (Calibre first, then EPUBs next to the audio).');
	else if (link.type === 'off') lines.push('🔗 Read-along is switched off for this book.');
	else if (link.type === 'calibre') lines.push(`🔗 Linked to Calibre #${link.id}${link.isbn ? ` (ISBN ${link.isbn})` : ''}.`);
	else lines.push(`🔗 Linked to the EPUB ${esc(link.path)}.`);
	const c = d.cache;
	if (c) {
		const words = Number.isFinite(c.totalWords) ? `, ${c.totalWords.toLocaleString('en-US')} words in ${c.sections} sections` : '';
		const state = c.valid ? '' : c.failed ? ` (unreadable: ${c.failed})` : ' (missing; read again on next use)';
		lines.push(`💾 Cached text: ${esc(c.label)}, ${sourceText(c.source)}${words}${state}.`);
	}
	const cands = d.candidates || {};
	if (cands.calibreError) lines.push(`📚 Calibre: ${cands.calibreError}.`);
	else if ((cands.calibre || []).length) {
		const list = cands.calibre.slice(0, LIST_MAX).map(b => `#${b.id} “${esc(b.title || '?')}”${b.epub ? '' : ' (no EPUB)'}${b.accepted ? ' ✅' : ''}`);
		lines.push(`📚 Calibre: ${list.join(' · ')}${cands.calibre.length > LIST_MAX ? ` and ${cands.calibre.length - LIST_MAX} more` : ''}`);
	}
	if ((cands.sidecars || []).length) {
		const list = cands.sidecars.slice(0, LIST_MAX).map(f => `${esc(f.file)} (${f.score})${f.accepted ? ' ✅' : ''}`);
		lines.push(`🗂 Next to the audio: ${list.join(' · ')}`);
	}
	if (d.lastError && d.lastError.text) lines.push(`⚠️ ${d.lastError.text}`);
	lines.push(`Link with \`${p}book link "${d.title || d.workId}" id:N\`, \`isbn:N\`, an EPUB path, \`off\` or \`auto\`.`);
	return lines.join('\n');
}

async function text(ctx) {
	const p = prefix();
	const ra = ctx.bot.readAlong;
	if (!ra) return ctx.say('📖 The read-along failed to load; check the bot log.');
	if (config.audiobookTextEnabled === false) return ctx.say(`📖 Read-along is turned off (\`${p}config\` → Audiobooks).`);
	const mode = (String(ctx.rest || '').split(/\s+/)[0] || '').toLowerCase();
	let r;
	try {
		if (!mode || mode === 'status') return ctx.say(await ra.status(ctx.userId));
		if (mode === 'on') r = await ra.turnOn({ userId: ctx.userId });
		else if (mode === 'off') r = await ra.turnOff(ctx.userId);
		else if (mode === 'now') r = await ra.sendNow(ctx.userId);
		else return ctx.say(`\`${p}book text\` takes \`on\`, \`off\` or \`now\` (nothing: what it is doing now).`);
	} catch (err) {
		logger.error('Read-along command failed:', (err && (err.code || err.name)) || 'error');
		return ctx.say('❌ That did not work; check the bot log.');
	}
	return ctx.say(r.text);
}

async function describe(ctx, work) {
	const source = ctx.bot.readAlong.source;
	const p = prefix();
	// A guild channel on the prefix path is public; a slash reply here is ephemeral, a DM is private.
	if (!ctx.guild || ctx.interaction) return ctx.say(formatDescribe(await source.describe(work, { paths: true }), p));
	const full = formatDescribe(await source.describe(work, { paths: true }), p);
	let sent = true;
	try {
		await ctx.bot.readAlong.dm(ctx.userId, { content: full.length > DM_MAX ? `${full.slice(0, DM_MAX - 1)}…` : full, allowedMentions: { parse: [] } });
	} catch (err) {
		sent = false;
		if (!err || err.code !== DM_CLOSED) logger.warn('!book link could not DM the details:', (err && (err.code || err.name)) || 'error');
	}
	const short = formatDescribe(await source.describe(work, { paths: false }), p);
	const tail = sent
		? '📩 Full details (with paths) sent to your DMs.'
		: `I can't DM you; run \`${p}book link ${work.id}\` in a DM with me to see the paths.`;
	return ctx.say(`${short}\n${tail}`);
}

async function doLink(ctx, work, target) {
	let r;
	try {
		r = await ctx.bot.readAlong.source.link(work, target, { by: ctx.userId });
	} catch (err) {
		logger.error('!book link failed:', (err && (err.code || err.name)) || 'error');
		return ctx.say('❌ That did not work; check the bot log.');
	}
	return ctx.say(`${r.ok ? '🔗' : '⛔'} ${r.text}`);
}

async function link(ctx) {
	const p = prefix();
	const owner = String(config.ownerId || '').trim();
	if (!owner) return ctx.say(`⛔ Set ownerId first (\`${p}config\` → Access); linking reads files on this PC, so it is owner-only.`);
	if (String(ctx.userId) !== owner) return ctx.say('⛔ Only the bot owner can link ebooks.');
	if (!ctx.bot.readAlong) return ctx.say('📖 The read-along failed to load; check the bot log.');
	if (config.audiobookTextEnabled === false) return ctx.say(`📖 Read-along is turned off (\`${p}config\` → Audiobooks).`);
	const rest = String(ctx.rest || '').trim();
	if (!rest) return ctx.say(linkUsage(p));
	const rd = parseLinkArgs(rest);
	const sure = rd.quoted || (rd.split && rd.split.explicit ? rd.split : null);
	if (sure) {
		const found = ctx.resolveWork(sure.workText, ctx.userId);
		if (found.error) return ctx.say(found.error);
		return doLink(ctx, found.work, sure.target);
	}
	// "Fahrenheit 451" must describe that book, never link "Fahrenheit" to Calibre #451.
	const whole = exactWork(rd.whole);
	if (whole) return describe(ctx, whole);
	if (rd.split) {
		const found = ctx.resolveWork(rd.split.workText, ctx.userId);
		if (found.work) return doLink(ctx, found.work, rd.split.target);
		return ctx.say(linkUsage(p));
	}
	const found = ctx.resolveWork(rd.whole, ctx.userId);
	if (found.error || !found.work) return ctx.say(`${found.error || 'Which book?'}\n${linkUsage(p)}`);
	return describe(ctx, found.work);
}

async function run(ctx) {
	if (ctx.sub === 'link') return link(ctx);
	return text(ctx);
}

module.exports = { names: ['text', 'link'], run, parseLinkArgs, isbn13, formatDescribe, linkUsage };
