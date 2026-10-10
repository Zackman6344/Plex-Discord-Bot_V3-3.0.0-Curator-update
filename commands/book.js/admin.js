// /book finish, forget and rescan. finish and forget go through the engine (bot.books), never
// the bookmark store directly: a live session of that work must end first, or its next periodic
// save would write the place straight back.

const config = require('../../config/config.js');
const bookModel = require('../../helpers/bookModel.js');
const logger = require('../../helpers/logger.js');

const CUSTOM_ID_MAX = 100;
const LIST_MAX = 10;
const CHUNK = 1900;
const LONG_GROUP_HOURS = 2;

function list(items, max = LIST_MAX) {
	const shown = items.slice(0, max).join(', ');
	return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

async function finish(ctx) {
	let work = null;
	if (!ctx.rest) {
		const s = ctx.guildId ? ctx.bot.books.session(ctx.guildId) : null;
		if (!s || s.userId !== ctx.userId) return ctx.say('Which book? `/book finish <title>`.');
		work = s.work;
	} else {
		const found = ctx.resolveWork(ctx.rest, ctx.userId);
		if (found.error) return ctx.say(found.error);
		work = found.work;
	}
	const r = ctx.bot.books.finish(ctx.userId, work, { guildId: ctx.guildId });
	return ctx.say(r.text);
}

async function forget(ctx) {
	let text = ctx.rest;
	let confirmed = false;
	const m = /^(.*?)\s+confirm$/i.exec(text);
	if (m) {
		text = m[1];
		confirmed = true;
	}
	const found = ctx.resolveWork(text, ctx.userId, { includeMissing: true });
	if (found.error) return ctx.say(found.error);
	const bookmarks = require('../../helpers/bookmarks.js');
	if (!bookmarks.get(ctx.userId, found.work || found.id)) return ctx.say(`You have no place saved in ${found.title}.`);
	if (ctx.interaction) {
		const id = `book:forget:${found.id}`;
		if (id.length > CUSTOM_ID_MAX) return ctx.say(`That book's id is too long for a button; run \`${config.commandPrefix}book forget ${found.id} confirm\`.`);
		return ctx.say({
			content: `Forget your place in **${found.title}**? Your listening time for it goes too. This cannot be undone.`,
			components: [{ type: 1, components: [{ type: 2, style: 4, custom_id: id, label: 'Forget it', emoji: { name: '🗑' } }] }]
		});
	}
	if (!confirmed) {
		return ctx.say(`This forgets your place in ${found.title} for good. Run \`${config.commandPrefix}book forget ${found.id} confirm\` to do it.`);
	}
	return ctx.say(ctx.bot.books.forget(ctx.userId, found.id).text);
}

// `!book rescan` answers in the open channel, so a folder is shown from below the music root
// (the drive and the folders above it stay private). bookCatalogStore.readOverrides widens a key
// copied from here back to the full one.
function shownKey(key) {
	const segs = String(key).split(/[\\/]+/).filter(Boolean);
	const root = segs.findIndex(s => /^music$/i.test(s));
	if (root >= 0 && root + 1 < segs.length) return segs.slice(root + 1).join('/');
	return segs.slice(-2).join('/');
}

// A network error names the Plex host and port. The full message is already in the log
// (bookLibrary.rebuild and rescan's own catch both write it).
function errorSummary(error) {
	const text = String(error || '');
	const code = /\b(E[A-Z][A-Z_]{2,})\b/.exec(text);
	if (code) return code[1];
	const status = /response code: (\d{3})\b/.exec(text);
	if (status) return `HTTP ${status[1]}`;
	return 'Plex did not answer';
}

function rescanText(report, catalog) {
	if (!report || !report.ok) {
		if (report && report.skipped === 'refreshing') return ['Plex is scanning the library right now. Try again when it finishes.'];
		if (report && report.skipped === 'empty-listing') return ['Plex returned no tracks, so the catalog was kept as it was.'];
		if (report && report.skipped === 'no-works') return ['No audiobooks or podcasts were detected, so the catalog was kept as it was.'];
		return [`❌ Rescan failed: ${errorSummary(report && report.error)}. The last catalog is still in use.`];
	}
	const titleOf = id => {
		const w = catalog.work(id);
		return w ? w.title : id;
	};
	const lines = [`📚 Rescanned: ${report.works} works (${report.books} books, ${report.podcasts} podcasts), ${report.parts} parts, ${bookModel.formatSpan(report.totalMs)}.`];
	if (report.persisted === false) lines.push('⚠️ The new catalog could not be written to disk; it is in use until the next restart.');
	if (report.overridesError) lines.push(`⚠️ book_overrides.json could not be read, so no overrides were applied: ${report.overridesError}`);
	if (report.added && report.added.length) lines.push(`➕ Added (${report.added.length}): ${list(report.added.map(titleOf))}`);
	if (report.removed && report.removed.length) lines.push(`➖ Removed (${report.removed.length}): ${list(report.removed)}`);
	const moved = Object.entries(report.moved || {});
	if (moved.length) lines.push(`↪ Renamed (${moved.length}), bookmarks follow: ${list(moved.map(([a, b]) => `${a} → ${b}`))}`);
	const low = (catalog.works() || []).filter(w => w.confidence === 'low');
	if (low.length) lines.push(`🔍 Check the part order of (${low.length}): ${list(low.map(w => w.title))}. A \`partOrder\` override fixes a wrong one.`);
	let rejected = [];
	try { rejected = (catalog.load().rejected || []).filter(r => Number(r.hours) >= LONG_GROUP_HOURS && r.reason !== 'excluded by override'); } catch (_) {}
	if (rejected.length) {
		const top = rejected.sort((a, b) => b.hours - a.hours).slice(0, 5).map(r => `${shownKey(r.folderKey)} (${Number(r.hours).toFixed(1)} h)`);
		lines.push(`🗂 Long groups not taken as books (add one under \`include\` in book_overrides.json): ${list(top, 5)}${rejected.length > 5 ? ` and ${rejected.length - 5} more` : ''}`);
	}
	for (const note of (report.notes || []).slice(0, LIST_MAX)) lines.push(`📝 ${note}`);
	return lines;
}

function chunks(lines) {
	const out = [];
	let cur = '';
	for (const raw of lines) {
		const line = raw.length > CHUNK ? raw.slice(0, CHUNK - 1) + '…' : raw;
		if (cur && cur.length + line.length + 1 > CHUNK) {
			out.push(cur);
			cur = '';
		}
		cur = cur ? `${cur}\n${line}` : line;
	}
	if (cur) out.push(cur);
	return out;
}

async function rescan(ctx) {
	const owner = config.ownerId;
	// Same bootstrap rule as /config: with no owner configured yet, anyone may.
	if (owner && ctx.userId !== String(owner)) return ctx.say('⛔ Only the bot owner can rescan the audiobook library.');
	await ctx.say('📚 Rescanning the audiobook library. It reads the whole music library, about 20 s.');
	let report;
	try {
		report = await require('../../helpers/bookLibrary.js').rebuild({ force: true });
	} catch (err) {
		logger.error('Audiobook rescan threw:', (err && err.message) || err);
		report = { ok: false, error: (err && err.message) || String(err) };
	}
	const catalog = require('../../helpers/bookCatalogStore.js');
	for (const chunk of chunks(rescanText(report, catalog))) await ctx.say(chunk);
	return null;
}

async function run(ctx) {
	if (ctx.sub === 'finish') return finish(ctx);
	if (ctx.sub === 'forget') return forget(ctx);
	if (ctx.sub === 'rescan') return rescan(ctx);
	return null;
}

module.exports = { names: ['finish', 'forget', 'rescan'], run, rescanText };
