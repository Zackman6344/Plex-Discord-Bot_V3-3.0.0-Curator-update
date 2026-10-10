// helpers/bookCard.js
//
// The audiobook card: one public message per session, rendered from the view object that
// helpers/bookEngine.js builds (see view() there for its shape). Pure: plain embed and component
// JSON, no discord.js, so a renderer fault can never reach playback.
//
// Every customId carries the session id (book:<action>:<sid>), so a click on an old card can be
// told apart from the live one. Ended-card ids carry the work id instead: the session is gone.

const bookModel = require('./bookModel.js');

const COLOR = {
	playing: 0x2ecc71,
	paused: 0xf1a33c,
	starting: 0x5865f2,
	ended: 0x99aab5,
	finished: 0xf1c40f
};
const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };
const CUSTOM_ID_MAX = 100;
const LIMITS = { title: 256, description: 4096, footer: 2048, label: 80 };
const NO_PINGS = { parse: [] };

const PAUSE_REASON = {
	'listener-left': 'left the voice channel. Press Resume when you are back.',
	unsubscribed: 'Something else took over the voice connection.',
	'plex-failing': 'Plex stopped sending audio. Press Resume to try again.',
	'file-ends-early': 'This file ends early.'
};

const END_REASON = {
	explicit: '⏹ Stopped',
	generic: '⏹ Stopped',
	sleep: '😴 Sleep timer',
	idle: '💤 Left voice: nobody resumed',
	'listener-left': '🎧 You left the channel',
	'voice-lost': '🔌 Lost the voice connection',
	shutdown: '🔄 The bot restarted',
	switched: '🔀 Switched to another book',
	'join-failed': '🔌 Couldn\'t join the voice channel',
	'failed-file': '⚠️ Stopped',
	forgotten: '🗑 Bookmark forgotten'
};

// Discord's markdown, in text that comes from file tags and folder names.
function esc(text) {
	return String(text === null || text === undefined ? '' : text).replace(/([\\*_`~|])/g, '\\$1');
}

function clip(text, max) {
	const s = String(text);
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function ts(ms) {
	return `<t:${Math.round(ms / 1000)}:R>`;
}

function clock(v, ms) {
	return bookModel.formatClock(ms, v.totalMs >= 3600000);
}

function byline(v) {
	const series = v.series ? (v.sequence !== null && v.sequence !== undefined ? `${v.series} #${v.sequence}` : v.series) : null;
	const voice = v.edition || (v.narrator ? `read by ${v.narrator}` : null);
	const parts = [v.author, series, voice].filter(Boolean).map(esc);
	return parts.length ? `*${parts.join(' · ')}*` : null;
}

// The byline, then a blank line before the status block.
function head(v) {
	const b = byline(v);
	return b ? [b, ''] : [];
}

function chapterLine(v) {
	if (!v.chapter) return null;
	return `**Chapter ${v.chapter.index} of ${v.chapter.count}** · ${esc(v.chapter.title)}`;
}

function sleepLine(v) {
	const s = v.sleep;
	if (!s) return null;
	if (s.mode === 'chapter') return '🌙 Stops at the end of this chapter';
	if (Number.isFinite(s.endsAt)) return `🌙 Sleep ${ts(s.endsAt)}`;
	return `🌙 Sleep after ${bookModel.formatSpan(s.remainingMs)} more listening`;
}

function sleepLabel(v) {
	const s = v.sleep;
	if (!s) return 'Sleep: off';
	if (s.mode === 'chapter') return 'Sleep: chapter';
	const minutes = Number.isFinite(s.minutes) ? s.minutes : Math.ceil((s.remainingMs || 0) / 60000);
	return `Sleep: ${minutes} min`;
}

function pausedLines(v) {
	const p = v.paused || {};
	const lines = [];
	let first = Number.isFinite(p.at) ? `⏸ Paused ${ts(p.at)}` : '⏸ Paused';
	if (Number.isFinite(p.leaveAt)) first += ` · I'll leave voice ${ts(p.leaveAt)} if nobody resumes`;
	lines.push(first);
	if (p.reason === 'listener-left') lines.push(`${esc(v.listener && v.listener.name)} ${PAUSE_REASON['listener-left']}`);
	else if (p.reason === 'file-ends-early' || p.reason === 'plex-failing') lines.push(`⚠️ ${esc(p.detail || PAUSE_REASON[p.reason])}`);
	else if (PAUSE_REASON[p.reason]) lines.push(PAUSE_REASON[p.reason]);
	return lines;
}

function saveWarning(v) {
	return v.saveHealthy === false ? '⚠️ Your place could not be written to disk just now. It is kept in memory and retried.' : null;
}

function button(customId, label, emoji, style, disabled) {
	if (customId.length > CUSTOM_ID_MAX) return null;
	const b = { type: 2, style, custom_id: customId, label: clip(label, LIMITS.label) };
	if (emoji) b.emoji = { name: emoji };
	if (disabled) b.disabled = true;
	return b;
}

function row(buttons) {
	const list = buttons.filter(Boolean).slice(0, 5);
	return list.length ? { type: 1, components: list } : null;
}

function embed(v, color, lines, footer) {
	const e = {
		color,
		title: clip(`📚 ${esc(v.title)}`, LIMITS.title),
		description: clip(lines.filter(l => l !== null && l !== undefined).join('\n'), LIMITS.description)
	};
	if (footer) e.footer = { text: clip(footer, LIMITS.footer) };
	return e;
}

function payload(e, rows) {
	return { content: '', embeds: [e], components: rows.filter(Boolean), allowedMentions: NO_PINGS };
}

/**
 * The live card (starting, playing or paused).
 * @param {object} v the engine's view
 * @returns {{ content, embeds, components, allowedMentions }}
 */
function buildCard(v) {
	const state = v.state === 'paused' || v.state === 'starting' ? v.state : 'playing';
	const lines = head(v);
	lines.push(chapterLine(v));
	lines.push(`${bookModel.progressBar(v.fraction)} ${Math.floor((v.fraction || 0) * 100)}%`);
	const at = v.speed !== 1 ? ` at ${v.speed}x` : '';
	lines.push(`${clock(v, v.positionMs)} / ${clock(v, v.totalMs)} · ${bookModel.formatSpan(v.remainingAtSpeedMs)} left${at}`);
	if (state === 'starting') lines.push('⏳ Joining the voice channel…');
	else if (state === 'paused') lines.push(...pausedLines(v));
	else if (v.buffering) lines.push('⏳ Loading…');
	else if (v.chapter && Number.isFinite(v.chapter.endsAt)) lines.push(`Chapter ends ${ts(v.chapter.endsAt)}`);
	lines.push(sleepLine(v));
	if (v.queuedMusicCount > 0) {
		const n = v.queuedMusicCount;
		lines.push(`🎵 ${n} music track${n === 1 ? '' : 's'} waiting (they play after /book stop)`);
	}
	lines.push(saveWarning(v));
	const room = v.voiceChannel && v.voiceChannel.name ? ` in 🔊 ${esc(v.voiceChannel.name)}` : '';
	if (v.listener) lines.push(`🎧 ${v.listener.mention}${room}`);
	const footer = `🎧 ${v.listener ? v.listener.name : 'someone'}'s book · ${v.speed}x · your place saves itself`;

	const sid = v.sessionId;
	const off = state === 'starting';
	const paused = state === 'paused';
	const controls = row([
		button(`book:prevch:${sid}`, 'Prev ch', '⏮️', STYLE.secondary, off),
		button(`book:back:${sid}`, '30 s', '⏪', STYLE.secondary, off),
		button(`book:toggle:${sid}`, paused ? 'Resume' : 'Pause', paused ? '▶️' : '⏸️', STYLE.primary, off),
		button(`book:fwd:${sid}`, '30 s', '⏩', STYLE.secondary, off),
		button(`book:nextch:${sid}`, 'Next ch', '⏭️', STYLE.secondary, off)
	]);
	const settings = row([
		button(`book:speed:${sid}`, `${v.speed}x`, '⚡', STYLE.secondary, off),
		button(`book:sleep:${sid}`, sleepLabel(v), '🌙', STYLE.secondary, off),
		button(`book:stop:${sid}`, 'Stop', '⏹️', STYLE.danger, false)
	]);
	return payload(embed(v, COLOR[state], lines, footer), [controls, settings]);
}

function endLine(v) {
	if (v.endReason === 'finished') {
		const f = v.finished;
		const span = f && Number.isFinite(f.days) ? ` in ${f.days} day${f.days === 1 ? '' : 's'}` : '';
		return `🎉 Finished ${esc(v.title)}${span}`;
	}
	if (v.endReason === 'failed-file') return `⚠️ ${esc(v.endDetail || 'Plex could not find the file.')}`;
	return END_REASON[v.endReason] || '⏹ Stopped';
}

/**
 * The card after the session ended: why, where it saved, and Resume / My shelf. "Mark finished"
 * shows only when the listener stopped within 2 minutes of the end; no stop finishes a work.
 */
function endedCard(v) {
	const lines = head(v);
	lines.push(endLine(v));
	if (v.endReason !== 'forgotten' && v.endReason !== 'finished' && v.endReason !== 'failed-file') {
		const ch = v.chapter ? ` (Ch ${v.chapter.index} of ${v.chapter.count})` : '';
		lines.push(`Saved at ${clock(v, v.positionMs)}${ch} of ${clock(v, v.totalMs)}.`);
	}
	lines.push(saveWarning(v));
	const finished = v.endReason === 'finished';
	const offerFinish = !!v.nearEnd && !finished && v.endReason !== 'forgotten';
	const buttons = row([
		v.endReason === 'forgotten' ? null : button(`book:resume:${v.workId}`, finished ? 'Listen again' : 'Resume', '▶️', STYLE.primary),
		button('book:shelf', 'My shelf', '📚', STYLE.secondary),
		offerFinish ? button(`book:finish:${v.workId}:${v.userId}`, 'Mark finished', '✅', STYLE.success) : null
	]);
	const footer = `🎧 ${v.listener ? v.listener.name : 'someone'}'s book`;
	return payload(embed(v, finished ? COLOR.finished : COLOR.ended, lines, footer), [buttons]);
}

/** What the previous card turns into after /book now posts a fresh one. */
function movedCard() {
	return { content: '📚 This card moved ↓', embeds: [], components: [], allowedMentions: NO_PINGS };
}

function plain(x) {
	return x && typeof x.toJSON === 'function' ? x.toJSON() : x;
}

/**
 * The ended card after its "Mark finished" button was used: the button goes, a line is added.
 * Built from the message itself because the session that rendered it no longer exists.
 * @param {{ embeds?: object[], components?: object[] }} message discord.js Message or raw JSON
 */
function finishedOnCard(message) {
	const embeds = ((message && message.embeds) || []).map(e => Object.assign({}, plain(e)));
	if (embeds[0]) {
		const desc = embeds[0].description ? `${embeds[0].description}\n` : '';
		embeds[0].description = clip(`${desc}🎉 Marked finished.`, LIMITS.description);
		embeds[0].color = COLOR.finished;
	}
	const components = ((message && message.components) || []).map(plain).map((r) => ({
		type: 1,
		components: ((r && r.components) || []).map(plain).filter(c => !String(c.custom_id || '').startsWith('book:finish:'))
	})).filter(r => r.components.length);
	return { embeds, components, allowedMentions: NO_PINGS };
}

module.exports = { buildCard, endedCard, movedCard, finishedOnCard, esc, CUSTOM_ID_MAX };
