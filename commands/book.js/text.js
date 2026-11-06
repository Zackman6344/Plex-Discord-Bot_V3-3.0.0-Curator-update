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
		`\`${p}book link "Fahrenheit 451" id:12\`. \`${p}book link <book>\` alone shows what it uses now. ` +
		`\`${p}book link <book> pictures:redo\` reads the book's Calibre PDF for pictures again; \`pictures:off\` and \`pictures:on\` hide and show them for that book.`;
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
	const pictures = /^pictures:(redo|off|on)$/.exec(lower);
	if (pictures) return { target: { type: 'pictures', action: pictures[1] }, explicit: true };
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

function candidateFormat(b) {
	const pdf = b.pdf ? ', + PDF' : '';
	if (b.epub) return pdf;
	if (b.format) return ` (${String(b.format).toUpperCase()}, converted to EPUB)${pdf}`;
	if (b.pdf) return ' (PDF only: no text, so no pictures either)';
	return ' (no EPUB, and no format that converts)';
}

// Why a book's PDF gives no pictures, by helpers/bookPictures.js's failure codes and in the words
// of its own `!book text` line.
const PICTURE_FAILURES = {
	'pdf-encrypted': 'it is encrypted',
	'pdf-damaged': 'it is damaged',
	'no-text-layer': 'it has no text layer to place them by',
	'align-failed': 'its pages don\'t match this ebook',
	'too-large': 'it is too large',
	'gave-up': 'reading it failed 3 times',
	'bad-result': 'the PDF reader left no usable pictures',
	timeout: 'it took too long',
	crash: 'it stopped unexpectedly',
	'calibre-unreachable': 'Calibre isn\'t answering',
	'calibre-auth': 'Calibre asked for a login',
	'calibre-off': 'Calibre is turned off',
	'io-error': 'a file could not be written',
	'pdf-missing': 'Calibre lists a PDF but has no file for it',
	'disk-error': 'the bot couldn\'t read or write its picture files',
	'tools-missing': 'Calibre\'s PDF tools weren\'t found on this PC'
};

/**
 * The 🖼 line of `!book link <book>` from the pictures' describe() report: the state, the PDF's
 * size, pages and date, how many pictures and how much of the text they line up with, any failure
 * and when it retries. Never a path. null with no report.
 * @param {{ state: string, pdfId?: number, pdf?: { id?: number, size?: number, mtime?: string },
 *   pages?: number, count?: number, share?: number, quality?: { share?: number },
 *   progress?: { stage: string, done: number, total: number }, code?: string, retryAt?: number }} r
 */
function picturesLine(r, p = prefix()) {
	if (!r || typeof r.state !== 'string') return null;
	const pdf = r.pdf && typeof r.pdf === 'object' ? r.pdf : {};
	const id = Number.isFinite(r.pdfId) ? r.pdfId : Number.isFinite(pdf.id) ? pdf.id : null;
	const record = id !== null ? `Calibre #${id}` : 'the Calibre record';
	const facts = [];
	if (Number.isFinite(pdf.size)) facts.push(`${(pdf.size / 1048576).toFixed(1)} MB`);
	if (Number.isInteger(r.pages) && r.pages > 0) facts.push(`${r.pages} pages`);
	const date = Date.parse(pdf.mtime);
	if (Number.isFinite(date)) facts.push(`<t:${Math.round(date / 1000)}:d>`);
	const name = `${id !== null ? `Calibre #${id}'s PDF` : 'the PDF'}${facts.length ? ` (${facts.join(', ')})` : ''}`;
	const why = PICTURE_FAILURES[r.code] || esc(r.code || 'an error');
	const share = Number.isFinite(r.share) ? r.share : (r.quality && Number.isFinite(r.quality.share) ? r.quality.share : null);
	const placed = share !== null ? ` (${Math.round(share * 100)}% of its pages placed)` : '';
	const kept = r.count > 0 ? `; ${r.count} kept` : '';
	const prog = r.progress || {};
	// Only the find and render stages count pages: the text layer is read in one step, 0 or 1 of 1.
	const at = (prog.stage === 'find' || prog.stage === 'render') && Number.isInteger(prog.total) && prog.total > 0 && Number.isInteger(prog.done)
		? `, page ${Math.max(0, Math.min(prog.done, prog.total))} of ${prog.total}` : '';
	// Only a text open moves a wait on, so a retry time already past means the next open.
	const retry = Number.isFinite(r.retryAt) && r.retryAt > Date.now() ? `<t:${Math.round(r.retryAt / 1000)}:R>` : 'the next time the book\'s text opens';
	switch (r.state) {
		case 'off': return `🖼 Pictures: off for every book (audiobookTextPictures in \`${p}config\` → Audiobooks)${kept}.`;
		case 'book-off': return `🖼 Pictures: switched off for this book${kept}.`;
		case 'not-calibre': return '🖼 Pictures: none; only a PDF on the Calibre record the text comes from has them.';
		case 'no-pdf':
			if (r.code === 'record-changed') return `🖼 Pictures: none; ${record} no longer holds the book this text came from.`;
			if (r.code === 'pdf-only') return `🖼 Pictures: none; ${record} has only its PDF left, no text to line it up with.`;
			return `🖼 Pictures: none; ${record} has no PDF.`;
		case 'unknown': return r.code ? `🖼 Pictures: not checked (${why}).` : '🖼 Pictures: not checked yet; the PDF is looked for when the text first opens.';
		case 'available': return `🖼 Pictures: ${name} is read the next time this book's text opens.`;
		case 'checking': return `🖼 Pictures: checking ${record} for a PDF.`;
		case 'queued': return `🖼 Pictures: ${name} is read after the book being read now.`;
		case 'downloading': return `🖼 Pictures: downloading ${name}.`;
		case 'running': return `🖼 Pictures: reading ${name}${at}.`;
		case 'aligning': return `🖼 Pictures: lining up the pictures of ${name} with this text.`;
		case 'ready':
			if (!(r.count > 0)) return `🖼 Pictures: none found in ${name}.`;
			return `🖼 Pictures: ${r.count} from ${name}, lined up with this text${placed}.`;
		case 'failed': return `🖼 Pictures: none from ${name}: ${why}${r.code === 'align-failed' ? placed : ''}.`;
		case 'waiting': return `🖼 Pictures: reading ${name} failed (${why}); it tries again ${retry}.`;
		case 'tools-missing': return '🖼 Pictures: Calibre\'s PDF tools weren\'t found on this PC; install Calibre here.';
		default: return `🖼 Pictures: ${esc(r.state)}.`;
	}
}

function converterLine(conv, p = prefix()) {
	if (!conv || conv.ok) return '🔄 A book Calibre has only as MOBI, AZW3 or similar is converted to EPUB with Calibre\'s ebook-convert the first time its text opens, which takes from a few seconds to a minute. The Calibre library is not changed.';
	if (conv.code === 'convert-off') return `🔄 Converting MOBI or AZW3 ebooks to EPUB is turned off (audiobookTextConvert in \`${p}config\` → Audiobooks), so those books have no text.`;
	if (conv.reason && conv.reason !== 'not-found') return `🔄 calibreConvertPath doesn't point at Calibre's ebook-convert (\`${p}config\` → Integrations; blank finds it), so MOBI or AZW3 books have no text.`;
	return `🔄 Calibre's ebook-convert wasn't found on this PC, so MOBI or AZW3 books have no text. Install Calibre here, or set calibreConvertPath (\`${p}config\` → Integrations).`;
}

/** The format the caller's book is converted from on its first open, from the source's last probe. */
function pendingFormat(ctx, ra) {
	try {
		const books = ctx.bot.books;
		const list = books && typeof books.sessions === 'function' ? books.sessions() || [] : [];
		const s = list.find(x => String(x.userId) === String(ctx.userId) && x.state !== 'ended' && x.state !== 'starting');
		if (!s || !s.work || typeof ra.source.pendingConversion !== 'function') return null;
		return ra.source.pendingConversion(s.work);
	} catch (_) {
		return null;
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
		const list = cands.calibre.slice(0, LIST_MAX).map(b => `#${b.id} “${esc(b.title || '?')}”${candidateFormat(b)}${b.accepted ? ' ✅' : ''}`);
		lines.push(`📚 Calibre: ${list.join(' · ')}${cands.calibre.length > LIST_MAX ? ` and ${cands.calibre.length - LIST_MAX} more` : ''}`);
	}
	const converts = (c && c.source && c.source.type === 'calibre' && c.source.format && c.source.format !== 'epub')
		|| (cands.calibre || []).slice(0, LIST_MAX).some(b => b.format && !b.epub);
	if (converts) lines.push(converterLine(d.converter, p));
	if ((cands.sidecars || []).length) {
		const list = cands.sidecars.slice(0, LIST_MAX).map(f => `${esc(f.file)} (${f.score})${f.accepted ? ' ✅' : ''}`);
		lines.push(`🗂 Next to the audio: ${list.join(' · ')}`);
	}
	const pics = picturesLine(d.pictures, p);
	if (pics) lines.push(pics);
	if (d.lastError && d.lastError.text) lines.push(`⚠️ ${d.lastError.text}`);
	const picForms = pics && d.pictures.state !== 'not-calibre' ? ' `pictures:redo`, `pictures:off` or `pictures:on` reads its PDF again, hides or shows the pictures.' : '';
	lines.push(`Link with \`${p}book link "${d.title || d.workId}" id:N\`, \`isbn:N\`, an EPUB path, \`off\` or \`auto\`.${picForms}`);
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
		if (!mode || mode === 'status') {
			const report = await ra.status(ctx.userId);
			const format = pendingFormat(ctx, ra);
			if (!format) return ctx.say(report);
			return ctx.say(`${report}\n🔄 Calibre has this book as ${String(format).toUpperCase()}; it is converted to EPUB the first time its text opens, which takes from a few seconds to a minute.`);
		}
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

async function picturesReport(ctx, work) {
	const pictures = ctx.bot.readAlong.pictures;
	if (!pictures || typeof pictures.describe !== 'function') return null;
	try {
		return await pictures.describe(work);
	} catch (err) {
		logger.warn('Read-along pictures: !book link could not describe them:', (err && (err.code || err.name)) || 'error');
		return null;
	}
}

async function describe(ctx, work) {
	const source = ctx.bot.readAlong.source;
	const p = prefix();
	const pictures = await picturesReport(ctx, work);
	const report = async paths => ({ ...(await source.describe(work, { paths })), pictures });
	// A guild channel on the prefix path is public; a slash reply here is ephemeral, a DM is private.
	if (!ctx.guild || ctx.interaction) return ctx.say(formatDescribe(await report(true), p));
	const full = formatDescribe(await report(true), p);
	let sent = true;
	try {
		await ctx.bot.readAlong.dm(ctx.userId, { content: full.length > DM_MAX ? `${full.slice(0, DM_MAX - 1)}…` : full, allowedMentions: { parse: [] } });
	} catch (err) {
		sent = false;
		if (!err || err.code !== DM_CLOSED) logger.warn('!book link could not DM the details:', (err && (err.code || err.name)) || 'error');
	}
	const short = formatDescribe(await report(false), p);
	const tail = sent
		? '📩 Full details (with paths) sent to your DMs.'
		: `I can't DM you; run \`${p}book link ${work.id}\` in a DM with me to see the paths.`;
	return ctx.say(`${short}\n${tail}`);
}

/**
 * `!book link auto` names no book: it is for the book playing in this server, else the caller's
 * most recently played one, and the reply says which, so a wrong guess shows at once.
 */
async function linkWithoutBook(ctx, target) {
	let work = null;
	let which = '';
	try {
		const books = ctx.bot.books;
		const s = ctx.guildId && books && typeof books.session === 'function' ? books.session(ctx.guildId) : null;
		if (s && s.work) {
			work = catalogStore().work(s.workId || s.work.id) || s.work;
			which = 'the book playing here';
		}
		if (!work) {
			for (const mark of require('../../helpers/bookmarks.js').forUser(String(ctx.userId))) {
				work = catalogStore().work(mark.workId);
				if (work) {
					which = 'your most recent book';
					break;
				}
			}
		}
	} catch (err) {
		logger.warn('!book link could not find the current book:', (err && err.message) || err);
	}
	if (!work) return ctx.say(`Which book? Nothing is playing here and you have no bookmarked book.\n${linkUsage()}`);
	return doLink(ctx, work, target, `📖 For **${esc(work.title)}**, ${which}:`);
}

// pictures:redo|off|on act on the book's PDF pictures only: no ebook link changes, so the
// Calibre index and the catalog are left as they are.
async function picturesCommand(ctx, work, action, lead) {
	const pictures = ctx.bot.readAlong.pictures;
	let r = null;
	try {
		if (pictures && typeof pictures.command === 'function') r = await pictures.command(work, action, { by: ctx.userId });
	} catch (err) {
		logger.error('Read-along pictures: !book link failed:', (err && (err.code || err.name)) || 'error');
		return ctx.say('❌ That did not work; check the bot log.');
	}
	if (!r || typeof r.text !== 'string') return ctx.say('🖼 Read-along pictures are not available; check the bot log.');
	const text = /^(🖼|⛔)/u.test(r.text) ? r.text : `${r.ok ? '🖼' : '⛔'} ${r.text}`;
	return ctx.say(`${lead ? `${lead}\n` : ''}${text}`);
}

async function doLink(ctx, work, target, lead = '') {
	if (target.type === 'pictures') return picturesCommand(ctx, work, target.action, lead);
	let r;
	try {
		r = await ctx.bot.readAlong.source.link(work, target, { by: ctx.userId });
	} catch (err) {
		logger.error('!book link failed:', (err && (err.code || err.name)) || 'error');
		return ctx.say('❌ That did not work; check the bot log.');
	}
	// The link picks the Calibre book that fills the catalog's blanks, so they change now rather
	// than at the next rebuild.
	if (r.ok) {
		// The Calibre index ranks a link above its own guesses; it matches again from its saved copy.
		try { require('../../helpers/calibreIndex.js').instance().rematch({ refresh: false }); } catch (_) {}
		try {
			const fresh = catalogStore().refreshMetadata();
			if (fresh && !fresh.ok) logger.warn(`!book link: saved, but the catalog could not be refreshed: ${fresh.error}`);
		} catch (err) {
			logger.warn('!book link: saved, but the catalog could not be refreshed:', (err && err.message) || err);
		}
	}
	return ctx.say(`${lead ? `${lead}\n` : ''}${r.ok ? '🔗' : '⛔'} ${r.text}`);
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
	const lone = targetOf(rd.whole);
	if (lone && lone.explicit) return linkWithoutBook(ctx, lone.target);
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
