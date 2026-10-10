// /book shelf, library, stats and leaderboard: read-only views of the catalog and the bookmark
// store. Nothing here touches Plex or voice.

const bookModel = require('../../helpers/bookModel.js');
const { renderBoard } = require('../../helpers/leaderboard.js');
const { esc } = require('../../helpers/bookCard.js');

const CHUNK = 1900;
const MAX_CHUNKS = 5;
const EMBED_MAX = 4096;
const CUSTOM_ID_MAX = 100;
const SHOWN_FINISHED = 10;
const COLOR = 0x2ecc71;

const EMPTY_SHELF = 'Your shelf is empty. `/book library` lists the books; `/book play <title>` starts one.';
const READING = '📚 The audiobook library is being read (about 20 s). Try again in a moment.';

function stores() {
	return {
		bookmarks: require('../../helpers/bookmarks.js'),
		catalog: require('../../helpers/bookCatalogStore.js')
	};
}

function hours(ms) {
	return `${((ms || 0) / 3600000).toFixed(1)} h`;
}

function sec(ms) {
	return Math.round(ms / 1000);
}

function clip(text, max) {
	const s = String(text);
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function edition(work) {
	return work && work.edition ? ` (${esc(work.edition)})` : '';
}

function listeningLine(mark, work, status) {
	const title = `**${esc(work ? work.title : mark.title)}**${edition(work)}`;
	if (status === 'missing') return `⚠️ ${title} · not in the library any more; your place is kept`;
	if (status === 'new-episodes') return `🆕 ${title} · new episodes since you caught up`;
	const total = bookModel.totalMs(work);
	const abs = Math.max(0, Math.min(mark.absoluteMs || 0, total));
	const speed = bookModel.SPEEDS.includes(mark.speed) ? mark.speed : 1;
	const bits = [`${total > 0 ? Math.floor((abs / total) * 100) : 0}%`];
	const ch = bookModel.chapterAt(work, abs);
	if (ch) bits.push(`Ch ${ch.number} of ${bookModel.chapters(work).length}`);
	bits.push(`${bookModel.formatSpan((total - abs) / speed)} left${speed !== 1 ? ` at ${speed}x` : ''}`);
	if (Number.isFinite(mark.lastListenedAt)) bits.push(`<t:${sec(mark.lastListenedAt)}:R>`);
	return `▶ ${title} · ${bits.join(' · ')}`;
}

function finishedLine(mark, work, status) {
	const title = `${esc(work ? work.title : mark.title)}${edition(work)}`;
	if (status === 'caught-up') return `✅ ${title} · caught up`;
	const when = Number.isFinite(mark.finishedAt) ? ` <t:${sec(mark.finishedAt)}:d>` : '';
	const times = mark.finishedCount > 1 ? ` (×${mark.finishedCount})` : '';
	return `✅ ${title} · finished${when}${times}`;
}

function fit(lines, budget) {
	const out = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length + 1 > budget) {
			out.push(`…and ${lines.length - out.length} more.`);
			break;
		}
		out.push(line);
		used += line.length + 1;
	}
	return out;
}

/**
 * The shelf as a reply payload: in progress (last listened first) with up to 5 Resume buttons,
 * then finished works collapsed. Shared by /book shelf and the ended card's "My shelf".
 * @returns {{ content, embeds, components }}
 */
function buildShelf(userId, given = {}) {
	const { bookmarks, catalog } = Object.assign(stores(), given);
	const marks = bookmarks.forUser(String(userId));
	if (!marks.length) return { content: EMPTY_SHELF, embeds: [], components: [] };
	const listening = [];
	const done = [];
	for (const mark of marks) {
		const work = catalog.work(mark.workId);
		const status = bookmarks.statusOf(mark, work);
		if (status === 'finished' || status === 'caught-up') done.push({ mark, work, status });
		else listening.push({ mark, work, status });
	}
	const recency = m => (Number.isFinite(m.lastListenedAt) ? m.lastListenedAt : m.updatedAt || 0);
	listening.sort((a, b) => recency(b.mark) - recency(a.mark));

	const parts = [];
	if (listening.length) parts.push('**Listening**', ...fit(listening.map(x => listeningLine(x.mark, x.work, x.status)), 2600));
	if (done.length) {
		const shown = done.slice(0, SHOWN_FINISHED).map(x => finishedLine(x.mark, x.work, x.status));
		if (done.length > SHOWN_FINISHED) shown.push(`…and ${done.length - SHOWN_FINISHED} more.`);
		if (parts.length) parts.push('');
		parts.push('**Finished**', ...fit(shown, 1200));
	}
	const buttons = listening
		.filter(x => x.work && `book:resume:${x.work.id}`.length <= CUSTOM_ID_MAX)
		.slice(0, 5)
		.map(x => ({ type: 2, style: 2, custom_id: `book:resume:${x.work.id}`, emoji: { name: '▶️' }, label: clip(x.work.title, 80) }));
	return {
		content: '',
		embeds: [{ color: COLOR, title: '📚 Your shelf', description: clip(parts.join('\n'), EMBED_MAX) }],
		components: buttons.length ? [{ type: 1, components: buttons }] : []
	};
}

function seqOf(work) {
	const n = Number(work.sequence);
	return Number.isFinite(n) ? n : Infinity;
}

/** The catalog grouped by series (or author for standalones), cut into messages of 1,900 chars. */
function libraryChunks(userId, filter, given = {}) {
	const { bookmarks, catalog } = Object.assign(stores(), given);
	const works = (filter ? catalog.findWorks(filter) : catalog.works()) || [];
	if (!works.length) return [filter ? `Nothing in the audiobook library matches "${filter}".` : READING];
	const groups = new Map();
	for (const w of works) {
		const key = w.series ? `s:${w.series}:${w.author}` : `a:${w.author}`;
		if (!groups.has(key)) groups.set(key, { header: w.series ? `**${esc(w.series)}** · ${esc(w.author || 'Unknown')}` : `**${esc(w.author || 'Unknown')}**`, works: [] });
		groups.get(key).works.push(w);
	}
	const total = works.reduce((s, w) => s + bookModel.totalMs(w), 0);
	const lines = [`📚 **Audiobook library**${filter ? ` matching "${esc(filter)}"` : ''} · ${works.length} work${works.length === 1 ? '' : 's'}, ${bookModel.formatSpan(total)}`];
	for (const g of groups.values()) {
		lines.push('', g.header);
		const sorted = g.works.slice().sort((a, b) => seqOf(a) - seqOf(b));
		for (const w of sorted) {
			const mark = bookmarks.get(String(userId), w);
			const len = bookModel.totalMs(w);
			const bits = [];
			if (w.kind === 'podcast') bits.push('🎙 podcast');
			bits.push(bookModel.formatSpan(len));
			if (mark && mark.finished) bits.push('✅');
			else if (mark && len > 0) bits.push(`${Math.floor((mark.absoluteMs / len) * 100)}%`);
			const seq = Number.isFinite(seqOf(w)) ? `#${w.sequence} ` : '';
			lines.push(`• ${seq}${esc(w.title)}${edition(w)} · ${bits.join(' · ')}`);
		}
	}
	const chunks = [];
	let cur = '';
	for (const line of lines) {
		const piece = clip(line, CHUNK);
		if (cur && cur.length + piece.length + 1 > CHUNK) {
			chunks.push(cur);
			cur = '';
		}
		cur = cur ? `${cur}\n${piece}` : piece;
	}
	if (cur) chunks.push(cur);
	if (chunks.length > MAX_CHUNKS) {
		const kept = chunks.slice(0, MAX_CHUNKS);
		kept[MAX_CHUNKS - 1] += '\n…and more. Narrow it with `/book library <filter>`.';
		return kept;
	}
	return chunks;
}

function statsEmbed(target, st) {
	const who = `<@${target.id}>`;
	const lines = [
		who,
		`🎧 **${hours(st.listenedMs)}** listened · **${hours(st.coveredMs)}** of book time covered`,
		`✅ ${st.worksFinished} finished (${st.totalFinishes} finish${st.totalFinishes === 1 ? '' : 'es'}) · ▶ ${st.inProgress} in progress`
	];
	if (st.byKind && st.byKind.podcast && st.byKind.podcast.works > 0) {
		lines.push(`📖 Books ${hours(st.byKind.book.listenedMs)} · 🎙 Podcasts ${hours(st.byKind.podcast.listenedMs)}`);
	}
	if (st.newEpisodes > 0) lines.push(`🆕 ${st.newEpisodes} podcast${st.newEpisodes === 1 ? ' has' : 's have'} new episodes`);
	if (st.top && st.top.length) {
		lines.push('', '**Most listened**');
		lines.push(...renderBoard(st.top, r => `${esc(r.title)} · ${hours(r.listenedMs)}`));
	}
	return { color: COLOR, title: '📚 Listening stats', description: clip(lines.join('\n'), EMBED_MAX) };
}

function statsTarget(ctx) {
	let user = null;
	try {
		if (ctx.interaction && ctx.interaction.options) user = ctx.interaction.options.getUser('user');
	} catch (_) {}
	if (!user && !ctx.interaction && ctx.message.mentions && ctx.message.mentions.users) {
		user = ctx.message.mentions.users.first() || null;
	}
	return user || { id: ctx.userId };
}

async function run(ctx) {
	const { bookmarks, catalog } = stores();
	switch (ctx.sub) {
		case 'shelf':
			return ctx.say(buildShelf(ctx.userId));
		case 'library': {
			if (!(catalog.works() || []).length) {
				require('./play.js').ensureLibrary(ctx.bot);
				return ctx.say(READING);
			}
			for (const chunk of libraryChunks(ctx.userId, ctx.rest)) await ctx.say(chunk);
			return null;
		}
		case 'stats': {
			const target = statsTarget(ctx);
			const st = bookmarks.statsFor(String(target.id), catalog);
			if (!st.works) return ctx.say(`<@${target.id}> has no audiobook bookmarks yet.`);
			return ctx.say({ embeds: [statsEmbed(target, st)] });
		}
		case 'leaderboard': {
			if (!ctx.guildId) return ctx.say('Run the leaderboard in a server.');
			// A bookmark opened and never listened to would rank at 0.0 h.
			const rows = bookmarks.leaderboardRows(ctx.guildId).filter(r => r.listenedMs > 0 || r.worksFinished > 0);
			if (!rows.length) return ctx.say('Nobody has listened to an audiobook here yet.');
			const lines = renderBoard(rows, r => `<@${r.userId}> · ${hours(r.listenedMs)} listened · ${r.worksFinished} finished`, { limit: 10 });
			return ctx.say({ embeds: [{ color: COLOR, title: '📚 Audiobook leaderboard', description: lines.join('\n') }] });
		}
		default:
			return null;
	}
}

module.exports = { names: ['shelf', 'library', 'stats', 'leaderboard'], run, buildShelf, libraryChunks, statsEmbed };
