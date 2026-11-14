// /apmedia list: one slot's titles that are ready, locked or done, grouped by show, album,
// playlist and kind, with the titles somebody hinted marked, and those whose rights a trap took.
// Long lists are paged behind buttons only the asker can turn.

const common = require('./common.js');

const WHICH = Object.freeze(['ready', 'locked', 'done']);
const VIEW = Object.freeze({
	ready: 'Ready to watch or hear now:',
	locked: 'Locked until an item from the multiworld opens them:',
	done: 'Done:',
});
const EMPTY = Object.freeze({
	ready: 'Nothing is ready: everything open is done, or nothing has been unlocked yet.',
	locked: 'Nothing is locked.',
	done: 'Nothing is done yet.',
});

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		return { which: common.opt(ctx, 'show') || 'ready', slot: String(common.opt(ctx, 'slot') ?? '').trim() };
	}
	const { values, rest } = common.takeKeys(ctx.rest, ['slot']);
	const words = rest.split(/\s+/).filter(Boolean);
	let which = 'ready';
	if (words.length && WHICH.includes(words[0].toLowerCase())) which = words.shift().toLowerCase();
	return { which, slot: values.slot !== undefined ? values.slot : words.join(' ') };
}

function rowLine(row, group, which) {
	let label = row.title;
	// The heading names the show already.
	if (row.kind === 'episode' && group.kind === 'show' && label.startsWith(`${group.name} `)) label = label.slice(group.name.length + 1);
	let line = `\u2022 ${common.esc(label)} \u00B7 ${row.runtime}`;
	if (row.tracks && row.tracks.done > 0) line += ` \u00B7 ${row.tracks.done} of ${row.tracks.total} tracks`;
	if (which === 'locked' && row.unit) line += ` \u00B7 opened by ${common.esc(row.unit)}${row.step > 1 ? ` (the ${common.ordinal(row.step)})` : ''}`;
	if (row.hinted) {
		const who = (row.hintedFor || []).map(common.slot);
		line += ` \u00B7 \u{1F4A1} ${who.length ? `hinted for ${who.join(', ')}` : 'hinted'}`;
	}
	if (row.expiredUntil) line += ` \u00B7 \u26D4 Rights expired until ${stamp(row.expiredUntil)}`;
	return line;
}

function stamp(ms) {
	return `<t:${Math.floor(Number(ms) / 1000)}:t>`;
}

/** The pages of one list() result. */
function listPages(res) {
	const head = [res.message, `**${VIEW[res.which] || VIEW.ready}**`];
	// Buffering holds whatever any title earns, so it heads every page.
	if (res.buffering) head.splice(1, 0, `\u23F3 Buffering: ${common.plural(res.buffering.held, 'check')} held until ${stamp(res.buffering.until)}.`);
	if (!res.groups.length) return [[...head.slice(0, -1), EMPTY[res.which] || EMPTY.ready].join('\n')];
	const blocks = res.groups.map((g) => ({
		title: `**${common.esc(g.name)}** (${g.done} of ${g.total} done)`,
		rows: g.rows.map((row) => rowLine(row, g, res.which)),
	}));
	return common.paginate(head, blocks);
}

async function run(ctx) {
	const input = readInput(ctx);
	const which = String(input.which || 'ready').toLowerCase();
	if (!WHICH.includes(which)) return ctx.say(`Show which titles? ${WHICH.map((w) => `\`${w}\``).join(', ')}.`);
	const r = common.slotFor(ctx, input.slot, { others: true });
	if (!r.ok) return ctx.say(r.message);
	const res = ctx.game.list(r.key, which);
	if (!res.ok) return ctx.say(res.message);
	return common.sendPages(ctx, listPages(res));
}

module.exports = { names: ['list'], run, listPages, rowLine };
