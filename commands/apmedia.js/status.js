// /apmedia status: per slot, how far the list got, the goal, the connection, the Plex account
// and how far the last Plex session reached. Anyone sees their own slots; the owner anyone's, and
// every slot when they name none.

const common = require('./common.js');

const ICON = Object.freeze({
	connected: '\u{1F7E2}',
	connecting: '\u{1F7E1}',
	waiting: '\u{1F7E1}',
	disconnected: '\u{1F7E0}',
	error: '\u{1F7E0}',
	refused: '\u{1F534}',
	stale: '\u{1F7E1}',
	orphaned: '\u26A0\uFE0F',
	off: '\u26AA',
	stopped: '\u26AA',
});
const STATE_WORD = Object.freeze({ refused: 'Refused', stale: 'Another seed', orphaned: 'Watch gone' });

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const user = common.optUser(ctx, 'user');
		return { slot: String(common.opt(ctx, 'slot') ?? '').trim(), userId: user ? String(user.id) : null };
	}
	const { ids, rest } = common.takeMentions(ctx.rest);
	return { slot: rest, userId: ids[0] || null };
}

function accountText(account) {
	if (!account) return 'none, so only Discord listening counts (the owner links one with `/apmedia account`)';
	if (account.implicit) return 'the server owner (account 1)';
	const name = account.name ? `${common.slot(account.name)} ` : '';
	return account.consent === 'granted'
		? `${name}(account ${account.accountId})`
		: `${name}(account ${account.accountId}), waiting for their consent, so only Discord listening counts for now`;
}

function block(row, { showUser }) {
	const icon = ICON[row.connection] || '\u26AA';
	const who = showUser ? ` for <@${row.userId}>` : '';
	const title = `${icon} ${common.slot(row.slot)} on watch #${row.watchId}${who}: ${row.connection}`;
	const lines = [];
	if (row.state !== 'active' && row.stateDetail && row.stateDetail.fix) {
		lines.push(`> ${STATE_WORD[row.state] || row.state}: ${row.stateDetail.fix}`);
	}
	if (row.total === null || row.total === undefined) {
		lines.push('> Its list is not known yet: it has not connected to the room.');
	} else {
		const goal = row.goalReached ? `goal of ${row.goalCount} reached` : `goal: finish ${row.goalCount}`;
		const start = row.inventoryKnown ? '' : ' (as at the start: the room has not reported its items yet)';
		lines.push(`> ${row.done} of ${row.total} done, ${goal}. ${row.ready} ready, ${row.locked} locked${start}.`);
	}
	if (row.pending || row.banked) {
		const parts = [];
		if (row.pending) parts.push(`${common.plural(row.pending, 'check')} waiting to send`);
		if (row.banked) parts.push(`${common.plural(row.banked, 'check')} banked until their titles unlock`);
		lines.push(`> ${parts.join(', ')}.`);
	}
	const tickets = row.wildTickets || {};
	if (tickets.available) lines.push(`> Wild Tickets: ${tickets.available} to spend with \`/apmedia redeem\`.`);
	lines.push(`> Plex account: ${accountText(row.account)}.`);
	if (row.lastSession) {
		const s = row.lastSession;
		const what = s.title ? common.bold(s.title) : 'a title that is not on the list';
		lines.push(`> Last Plex session: ${what}, ${s.note ? `reached ${s.note}` : `reached ${s.percent}%`}.`);
	}
	if (row.lastCredit && row.lastCredit.title) {
		const at = Number(row.lastCredit.at);
		lines.push(`> Last credit: ${common.bold(row.lastCredit.title)}${Number.isFinite(at) && at > 0 ? ` <t:${Math.floor(at / 1000)}:R>` : ''}.`);
	}
	if (row.announce === false) lines.push('> Announcements: off.');
	return { title, rows: lines };
}

async function run(ctx) {
	const input = readInput(ctx);
	const owner = common.isOwner(ctx.userId);
	let target = owner ? undefined : ctx.userId;
	if (input.userId && input.userId !== ctx.userId) {
		const gate = common.ownerOnly(ctx, 'see someone else\'s slots');
		if (gate) return ctx.say(gate);
		target = input.userId;
	} else if (input.userId) {
		target = ctx.userId;
	}
	if (input.slot) {
		const r = common.slotFor(ctx, input.slot, { others: true });
		if (!r.ok) return ctx.say(r.message);
		target = r.key;
	}
	const res = ctx.game.status(target);
	const head = [res.message];
	if (!res.bindings.length) {
		head.push(`Once a seed with your list is up, claim your slot with \`${ctx.p}ap claim <slot>\`, then \`/apmedia link <slot>\`.`);
		return ctx.say(head.join('\n'));
	}
	const blocks = res.bindings.map((row) => block(row, { showUser: owner && row.userId !== ctx.userId }));
	return common.sendPages(ctx, common.paginate(head, blocks));
}

module.exports = { names: ['status'], run, block };
