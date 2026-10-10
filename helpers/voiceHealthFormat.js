// helpers/voiceHealthFormat.js
//
// Renders a helpers/voiceHealth.js snapshot as one Discord message. Kept apart from the command so
// the 2000-character arithmetic is testable without discord.js.

const MESSAGE_LIMIT = 2000;
const EVENT_WIDTH = 80;

const LEGEND = 'G gap>=100ms  U source starved>=100ms  N voice dropped  L loop p99>=50ms  C machine CPU>=90%';
const HEADER = 'time    pkts g40 g100 maxg undr ping el99/max cpu sys heap/rss flags';

function flags(m) {
	let f = '';
	if (m.gaps && m.gaps[100] > 0) f += 'G';
	if (m.underMs >= 100) f += 'U';
	if (m.drops > 0) f += 'N';
	if (m.el && m.el.p99 >= 50) f += 'L';
	if (m.sys !== null && m.sys !== undefined && m.sys >= 90) f += 'C';
	return f || '.';
}

function hostClock(iso) {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function row(m, timeOf) {
	const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v)}`);
	return [
		(timeOf(m.t) + (m.partial ? '*' : '')).padEnd(6),
		String(m.pkts).padStart(6),
		String(m.gaps[40]).padStart(4),
		String(m.gaps[100]).padStart(5),
		String(m.maxGap).padStart(5),
		String(m.underMs).padStart(5),
		(m.ping ? String(m.ping.max) : '-').padStart(5),
		`${Math.round(m.el.p99)}/${Math.round(m.el.max)}`.padStart(9),
		pct(m.cpu).padStart(4),
		pct(m.sys).padStart(4),
		`${m.heapMB}/${m.rssMB}`.padStart(9),
		' ' + flags(m)
	].join('');
}

function eventLine(e, timeOf) {
	const { t, type, ...rest } = e;
	const detail = Object.entries(rest)
		.filter(([, v]) => v !== undefined && v !== null && v !== '')
		.map(([k, v]) => `${k}=${v}`)
		.join(' ');
	const line = `${timeOf(t)} ${type} ${detail}`.trim();
	return line.length > EVENT_WIDTH ? line.slice(0, EVENT_WIDTH - 1) + '…' : line;
}

/**
 * @param {object} snap voiceHealth.snapshot()
 * @param {object} [opts]
 * @param {number} [opts.minutes] the window asked for, for the title
 * @param {string} [opts.title] replaces the default title line
 * @param {number} [opts.maxEvents]
 * @param {(iso: string) => string} [opts.timeOf] clock label; defaults to the host's local HH:MM
 * @param {number} [opts.limit]
 */
function render(snap, { minutes = 15, title = null, maxEvents = 10, timeOf = hostClock, limit = MESSAGE_LIMIT } = {}) {
	const active = snap.minutes.filter((m) => m.active);
	if (snap.current && (snap.current.pkts > 0 || snap.current.events > 0)) active.push(snap.current);
	const hidden = snap.minutes.length - snap.minutes.filter((m) => m.active).length;

	const head = title || `**Voice health, last ${minutes} min** (host clock${hidden ? `, ${hidden} idle min hidden` : ''})`;
	const rows = active.map((m) => row(m, timeOf));
	const evs = snap.events.slice(-maxEvents).map((e) => eventLine(e, timeOf));

	const build = () => {
		const table = rows.length ? [HEADER, ...rows].join('\n') : 'No voice activity in this window.';
		const events = evs.length ? ['events:', ...evs].join('\n') : 'events: none';
		return `${head}\n\`\`\`\n${table}\n\n${events}\n\n${LEGEND}\n\`\`\``;
	};
	let text = build();
	// Oldest minutes go first: whoever asks is looking at what just happened.
	while (text.length > limit && rows.length > 1) {
		rows.shift();
		text = build();
	}
	while (text.length > limit && evs.length > 0) {
		evs.shift();
		text = build();
	}
	return text.length > limit ? text.slice(0, limit - 4) + '\n```' : text;
}

module.exports = { render, flags, row, eventLine, hostClock, HEADER, LEGEND, MESSAGE_LIMIT };
