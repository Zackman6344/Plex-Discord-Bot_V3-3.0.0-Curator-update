// /book finish, forget and rescan. finish and forget go through the engine (bot.books), never
// the bookmark store directly: a live session of that work must end first, or its next periodic
// save would write the place straight back.

const config = require('../../config/config.js');
const bookCatalog = require('../../helpers/bookCatalog.js');
const bookModel = require('../../helpers/bookModel.js');
const logger = require('../../helpers/logger.js');

const CUSTOM_ID_MAX = 100;
const LIST_MAX = 10;
const CHUNK = 1900;
const LONG_GROUP_HOURS = 2;
const DOUBT_MAX = 5;
const NAME_MAX = 80;
const DRIVE_RE = /^[A-Za-z]:$/;
const ONLINE_WAIT_MS = 60 * 1000;

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

// `!book rescan` answers in the open channel, so a folder is shown from below its music section's
// folder (the drive and the folders above it stay private), or below a folder named Music when the
// catalog predates meta.roots. bookCatalogStore.readOverrides widens a key copied from here back to
// the full one, because what is left is always the end of the key. A split piece's
// `#album:<ratingKey>` is dropped: Plex ids stay out of the channel too.
function shownKey(key, roots = []) {
	const raw = String(key).replace(/#album:[^\\/]*$/, '');
	if (/^album:/.test(raw)) return 'an album included by hand';
	let segs = raw.split(/[\\/]+/).filter(Boolean);
	const lower = segs.map(s => s.toLowerCase());
	let rootLen = 0;
	for (const r of Array.isArray(roots) ? roots : []) {
		const rs = String(r || '').split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase());
		if (rs.length > rootLen && rs.length <= lower.length && rs.every((s, i) => s === lower[i])) rootLen = rs.length;
	}
	if (rootLen) {
		if (rootLen < segs.length) return segs.slice(rootLen).join('/');
		const last = segs[rootLen - 1];
		return DRIVE_RE.test(last) ? 'the top of a music folder' : last;
	}
	// A UNC path starts with the host's name.
	if (/^[\\/]{2}[^\\/]/.test(raw)) segs = segs.slice(1);
	segs = segs.filter(s => !DRIVE_RE.test(s));
	const root = segs.findIndex(s => /^music$/i.test(s));
	if (root >= 0 && root + 1 < segs.length) return segs.slice(root + 1).join('/');
	return segs.slice(-2).join('/') || 'the top of a drive';
}

function esc(text) {
	const s = String(text === null || text === undefined ? '' : text);
	const clipped = s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
	return clipped.replace(/([\\*_`~|])/g, '\\$1');
}

function andList(items, max = 3) {
	if (items.length > max) return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
	if (items.length < 2) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function plural(n, one, many = `${one}s`) {
	return `${n} ${n === 1 ? one : many}`;
}

const albumName = (title) => (title ? esc(title) : 'an untitled album');

// A 'split' doubt is told on the split line instead, and a code added later is left out rather
// than printed raw.
function doubtReason(d) {
	if (!d || typeof d !== 'object') return null;
	const albums = () => andList((Array.isArray(d.albums) ? d.albums : []).map(albumName));
	switch (d.code) {
		case 'mixed-artists': {
			const artists = (Array.isArray(d.artists) ? d.artists : [])
				.filter(a => a && String(a.name || '').trim())
				.map(a => `${esc(a.name)} (${Number(a.tracks) || 0})`);
			return artists.length ? `tracks by ${andList(artists)}` : 'tracks by several artists';
		}
		case 'music-genre': return `music genre on ${albums() || 'one of its albums'}`;
		case 'generic-folder': {
			const n = Number(d.albums) || 0;
			const spans = n > 1 ? ` and spans ${n} albums` : '';
			return d.folder ? `folder name "${esc(d.folder)}" is generic${spans}` : `its folder is the top of a drive${spans}`;
		}
		case 'generic-title': return `the title "${esc(d.title)}" looks like a folder name`;
		case 'no-author': return 'no author found';
		default: return null;
	}
}

function doubtLines(works) {
	const p = config.commandPrefix || '!';
	const doubtful = works
		.map(w => ({ w, reasons: bookCatalog.openDoubts(w).map(doubtReason).filter(Boolean) }))
		.filter(x => x.reasons.length);
	if (!doubtful.length) return [];
	const lines = [`⚠️ Doubtful groups, catalogued anyway (${doubtful.length}):`];
	for (const { w, reasons } of doubtful.slice(0, DOUBT_MAX)) {
		lines.push(`• **${esc(w.title)}** (\`${w.id}\`): ${reasons.join('; ')}. Fix: \`${p}book edit ${w.id} exclude\`, or a title or author edit.`);
	}
	const rest = doubtful.slice(DOUBT_MAX);
	if (rest.length) lines.push(`• and ${rest.length} more: ${list(rest.map(x => `\`${x.w.id}\``))}`);
	return lines;
}

function splitLines(splits, works) {
	if (!Array.isArray(splits) || !splits.length) return [];
	const byKey = new Map(works.map(w => [w.folderKey, w]));
	const items = splits.map(sp => {
		const from = byKey.get(sp.folderKey);
		return `${albumName(sp.albumTitle)} (${plural(Number(sp.tracks) || 0, 'track')})${from ? ` from **${esc(from.title)}**` : ''}`;
	});
	return [`✂️ Music split off a book folder (${splits.length}): ${list(items, 5)}. Plex tags it as music, so it stays in the music library.`];
}

// Online data only fills what every other source left blank (and fixes a title's case), so a
// fill is all there is to show; work.sources names the fields it supplied.
function filledFields(w) {
	const s = w.sources;
	if (!s || typeof s !== 'object') return [];
	const out = [];
	if (s.title === 'online') out.push('title case');
	if (s.author === 'online' && w.author) out.push(`author ${esc(w.author)}`);
	if ((s.series === 'online' || s.sequence === 'online') && w.series) out.push(`series ${esc(w.series)}${w.sequence !== null && w.sequence !== undefined ? ` #${w.sequence}` : ''}`);
	if (s.narrator === 'online' && w.narrator) out.push(`narrator ${esc(w.narrator)}`);
	if (s.publisher === 'online' && w.publisher) out.push(`publisher ${esc(w.publisher)}`);
	if (s.edition === 'online' && w.edition) out.push(`edition ${esc(w.edition)}`);
	return out;
}

function onlineLines(online, works) {
	if (!online || typeof online !== 'object') return [];
	if (online.pending) return ['🌐 Online lookups are still running; what they fill in shows after they finish.'];
	if (!online.enabled) return [];
	const c = online.counts || {};
	const counts = [
		[c.edition, 'edition match', 'edition matches'],
		[c.book, 'book match', 'book matches'],
		[c.none, 'not found', 'not found'],
		[c.cached, 'already looked up', 'already looked up'],
		[c.skipped, 'skipped', 'skipped'],
		[c.error, 'failed', 'failed'],
	].filter(([n]) => Number(n) > 0).map(([n, one, many]) => plural(Number(n), one, many));
	const stopped = online.stopped ? ` Stopped after failures in a row; ${plural(Number(c.deferred) || 0, 'book')} left for the next rescan.` : '';
	const lines = [`🌐 Online lookup: ${counts.length ? counts.join(', ') : 'nothing to look up'}.${stopped}`];
	const changed = new Set(Array.isArray(online.changed) ? online.changed : []);
	const filled = works.filter(w => changed.has(w.id)).map(w => ({ w, fields: filledFields(w) })).filter(x => x.fields.length);
	if (filled.length) {
		const shown = filled.slice(0, 5).map(({ w, fields }) => `**${esc(w.title)}**: ${fields.join(', ')}`).join('; ');
		lines.push(`🌐 Filled in online (${filled.length}): ${shown}${filled.length > 5 ? `; and ${filled.length - 5} more` : ''}`);
	}
	return lines;
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
	const works = catalog.works() || [];
	const low = works.filter(w => w.confidence === 'low');
	if (low.length) lines.push(`🔍 Check the part order of (${low.length}): ${list(low.map(w => w.title))}. A \`partOrder\` override fixes a wrong one.`);
	lines.push(...doubtLines(works));
	lines.push(...splitLines(report.splits, works));
	lines.push(...onlineLines(report.online, works));
	let rejected = [];
	let roots = [];
	try {
		const stored = catalog.load();
		roots = (stored.meta && stored.meta.roots) || [];
		// A split piece is already named on the split line.
		rejected = (stored.rejected || []).filter(r => Number(r.hours) >= LONG_GROUP_HOURS && r.reason !== 'excluded by override' && !String(r.folderKey).includes('#album:'));
	} catch (_) {}
	if (rejected.length) {
		const top = rejected.sort((a, b) => b.hours - a.hours).slice(0, 5).map(r => `${shownKey(r.folderKey, roots)} (${Number(r.hours).toFixed(1)} h)`);
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

// The batch runs at most one request a second and is cached for months, so a rescan after the
// first finds almost everything cached; a long first batch is reported as still running rather
// than holding the reply.
async function onlineSummary(library, report) {
	const batch = typeof library.onlineBatch === 'function' ? library.onlineBatch(report) : null;
	if (!batch) return null;
	let timer = null;
	const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ pending: true }), ONLINE_WAIT_MS); });
	try {
		return await Promise.race([batch, timeout]);
	} catch (_) {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function rescan(ctx) {
	const owner = config.ownerId;
	// Same bootstrap rule as /config: with no owner configured yet, anyone may.
	if (owner && ctx.userId !== String(owner)) return ctx.say('⛔ Only the bot owner can rescan the audiobook library.');
	const online = config.audiobookOnlineLookup === true ? ' Then it looks books up online, up to a minute more.' : '';
	await ctx.say(`📚 Rescanning the audiobook library. It reads the whole music library, about 20 s, up to a minute the first time after an update.${online}`);
	const library = require('../../helpers/bookLibrary.js');
	let report;
	try {
		report = await library.rebuild({ force: true });
		if (report && report.ok) {
			const summary = await onlineSummary(library, report);
			if (summary) report.online = summary;
		}
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

module.exports = { names: ['finish', 'forget', 'rescan'], run, rescanText, shownKey, chunks, doubtReason };
