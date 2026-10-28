// /book calibre (owner): which audiobooks have no Calibre record, which have several, and the
// state of the Calibre index (helpers/calibreIndex.js).
//
// Read from the index's saved copy only, so the reply never waits on Calibre; `refresh` starts a
// read of the library in the background and says so. Replies name books by title and id and
// Calibre records by id and title, never a path.

const config = require('../../config/config.js');
const logger = require('../../helpers/logger.js');

const CHUNK = 1900;
const MAX_CHUNKS = 5;
const NAME_MAX = 80;
const CANDIDATES_MAX = 4;
const SHOWS = ['missing', 'all', 'refresh'];

const index = () => require('../../helpers/calibreIndex.js').instance();
const catalogStore = () => require('../../helpers/bookCatalogStore.js');
const prefix = () => config.commandPrefix || '!';

function esc(text) {
	const s = String(text === null || text === undefined ? '' : text);
	const clipped = s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
	return clipped.replace(/([\\*_`~|])/g, '\\$1');
}

function when(ms) {
	return `<t:${Math.round(ms / 1000)}:R>`;
}

function offText(idx) {
	const p = prefix();
	if (!idx.configured()) return `📚 Calibre is not set up. Set \`calibreUrl\` (\`${p}config\`, Integrations) to your Calibre content server, then turn on \`audiobookCalibreSort\` (Audiobooks).`;
	return `📚 The Calibre index is off. The owner can turn it on with \`${p}config\`, under Audiobooks (\`audiobookCalibreSort\`). It reads your Calibre library's titles, authors, series and tags, and never writes to it.`;
}

function recordName(idx, id) {
	const r = idx.recordOf(id);
	return r && r.title ? `#${id} “${esc(r.title)}”` : `#${id}`;
}

const PIN_PROBLEMS = {
	missing: 'that book is gone from Calibre',
	'uuid-changed': 'that id is another book now',
	'other-library': 'it was set in another Calibre library'
};

/** Each audiobook (podcasts left out) with its match, sorted into what the report lists. */
function sortOut(works, idx) {
	const out = { exact: [], pinned: [], likely: [], ambiguous: [], none: [], forbidden: [], broken: [] };
	for (const w of works) {
		if (w.kind === 'podcast') continue;
		const m = idx.matchFor(w) || { id: null, verdict: 'none', method: 'no match' };
		const row = { w, m };
		if (m.method === 'pin' && m.problem) out.broken.push(row);
		else if (m.method === 'pin' && m.id === null) out.forbidden.push(row);
		else if (m.method === 'pin' && m.verdict === 'exact') out.pinned.push(row);
		else if (m.verdict === 'exact') out.exact.push(row);
		else if (m.verdict === 'likely') out.likely.push(row);
		else if (m.verdict === 'ambiguous') out.ambiguous.push(row);
		else out.none.push(row);
	}
	return out;
}

function statusLines(idx) {
	const st = idx.status();
	const lib = st.libraryId ? `Calibre library "${esc(st.libraryId)}"` : 'The Calibre library';
	const lines = [];
	if (st.fetchedAt) lines.push(`${lib}: ${st.books} book${st.books === 1 ? '' : 's'} in the saved copy, read ${when(st.fetchedAt)}.`);
	else lines.push(`${lib} has not been read yet.`);
	if (st.running) lines.push('Reading Calibre now.');
	else if (st.answered === false) {
		const next = st.backoffUntil ? ` The next automatic try is ${when(st.backoffUntil)}.` : '';
		lines.push(`Calibre did not answer at the last check${st.lastAttemptAt ? ` ${when(st.lastAttemptAt)}` : ''} (${esc(st.lastError || 'no answer')}). The saved copy is used.${next}`);
	} else if (st.checkedAt) lines.push(`Calibre answered at the last check ${when(st.checkedAt)}.`);
	return lines;
}

// Two narrations of one title are told apart the way the library lists them.
function rowName(w) {
	const which = w.edition ? ` (${esc(w.edition)})` : w.narrator ? ` (read by ${esc(w.narrator)})` : '';
	return `**${esc(w.title)}**${which}${w.author ? ` · ${esc(w.author)}` : ''}`;
}

/**
 * The report as messages of at most 1,900 characters, 5 at most.
 * @param {object[]} works
 * @param {object} idx the Calibre index
 * @param {'missing'|'all'} show
 */
function reportChunks(works, idx, show = 'missing') {
	const p = prefix();
	const s = sortOut(works, idx);
	const total = Object.values(s).reduce((n, list) => n + list.length, 0);
	const lines = [
		`📚 **Calibre matches** · ${total} audiobook${total === 1 ? '' : 's'}: ${s.exact.length} exact, ${s.pinned.length} pinned, ${s.likely.length} likely, ${s.ambiguous.length} ambiguous, ${s.none.length + s.broken.length} with no match${s.forbidden.length ? `, ${s.forbidden.length} set to none` : ''}`,
		...statusLines(idx)
	];
	if (s.broken.length) {
		lines.push('', `⚠️ **Pins to check** (${s.broken.length})`);
		for (const { w, m } of s.broken) lines.push(`• ${rowName(w)}: pinned to #${m.id}, but ${PIN_PROBLEMS[m.problem] || 'it no longer holds'}.`);
	}
	if (s.ambiguous.length) {
		lines.push('', `**Several Calibre books fit** (${s.ambiguous.length}); pick one with \`${p}book edit <book> calibre <id>\``);
		for (const { w, m } of s.ambiguous) {
			const ids = (m.candidates || []).slice(0, CANDIDATES_MAX).map((id) => recordName(idx, id));
			lines.push(`• ${rowName(w)}: ${ids.join(', ') || 'no candidates kept'}`);
		}
	}
	if (show === 'all') {
		const matched = [...s.pinned, ...s.exact, ...s.likely];
		if (matched.length) {
			lines.push('', `**Matched** (${matched.length})`);
			for (const { w, m } of matched) {
				const how = m.method === 'pin' ? 'your pin' : m.method === 'link' ? 'your ebook link' : m.method === 'read-along' ? 'the read-along\'s ebook' : `${m.verdict}: ${m.method}`;
				lines.push(`• ${rowName(w)}: ${recordName(idx, m.id)} (${how})`);
			}
		}
		if (s.forbidden.length) {
			lines.push('', `**Set to none** (${s.forbidden.length})`);
			for (const { w } of s.forbidden) lines.push(`• ${rowName(w)}`);
		}
	}
	if (s.none.length) {
		lines.push('', `**No Calibre match** (${s.none.length})`);
		for (const { w } of s.none) lines.push(`• ${rowName(w)}`);
	}
	if (s.none.length || s.ambiguous.length || s.broken.length) {
		lines.push('', `Tip: add the book to Calibre (a record with no file is fine: Add books, then Add empty book) and it is matched at the next check, or tie one by its id: \`${p}book edit <book> calibre <id>\`. \`calibre none\` stops a wrong match.`);
	}
	if (show !== 'all') lines.push(`\`${p}book calibre all\` also lists the matched books; \`${p}book calibre refresh\` reads Calibre again now.`);

	const chunks = [];
	let cur = '';
	for (const line of lines) {
		const piece = line.length > CHUNK ? line.slice(0, CHUNK - 1) + '…' : line;
		if (cur && cur.length + piece.length + 1 > CHUNK) {
			chunks.push(cur);
			cur = '';
		}
		cur = cur ? `${cur}\n${piece}` : piece;
	}
	if (cur) chunks.push(cur);
	if (chunks.length > MAX_CHUNKS) {
		const kept = chunks.slice(0, MAX_CHUNKS);
		kept[MAX_CHUNKS - 1] += `\n…and more. \`${p}book calibre\` without \`all\` lists only the books that need you.`;
		return kept;
	}
	return chunks;
}

async function run(ctx) {
	const p = prefix();
	const owner = String(config.ownerId || '').trim();
	if (!owner) return ctx.say(`⛔ Set ownerId first (\`${p}config\` → Access); the Calibre report is owner-only.`);
	if (String(ctx.userId) !== owner) return ctx.say('⛔ Only the bot owner can see the Calibre report.');
	const word = String(ctx.rest || '').trim().toLowerCase();
	const show = word || 'missing';
	if (!SHOWS.includes(show)) return ctx.say(`\`${p}book calibre\` takes missing (the default), all or refresh.`);
	const idx = index();
	if (!idx.enabled()) return ctx.say(offText(idx));
	const st = idx.status();
	if (show === 'refresh' || !st.fetchedAt) {
		idx.refresh({ force: true }).then((r) => {
			if (r && r.ok) logger.info(`!book calibre: read ${r.books} Calibre books.`);
		}, () => {});
		const first = show === 'refresh' ? '' : 'The Calibre library has not been read yet. ';
		// The status from before this try: a wrong address or password would otherwise get the same
		// hopeful answer every time.
		if (st.answered === false) {
			const at = st.lastAttemptAt ? ` ${when(st.lastAttemptAt)}` : '';
			return ctx.say(`📚 ${first}Calibre did not answer the last time${at} (${esc(st.lastError || 'no answer')}). Trying again in the background. \`${p}book calibre\` shows the result.`);
		}
		return ctx.say(`📚 ${first}Reading the Calibre library in the background, a few seconds while Calibre is open. \`${p}book calibre\` shows the result.`);
	}
	const works = catalogStore().works() || [];
	if (!works.length) return ctx.say('📚 The audiobook library is being read. Try again in a moment.');
	for (const chunk of reportChunks(works, idx, show)) await ctx.say(chunk);
	return null;
}

module.exports = { names: ['calibre'], run, reportChunks, sortOut };
