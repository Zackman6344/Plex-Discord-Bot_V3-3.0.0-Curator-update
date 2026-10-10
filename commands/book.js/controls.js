// /book pause, resume, stop, back, forward, goto, chapter, speed, sleep and now: thin calls into
// the engine, which checks who may do what (plan 3.11) and refuses while it is still joining.

const bookModel = require('../../helpers/bookModel.js');

const CONTROL = {
	pause: 'pause',
	resume: 'resume',
	stop: 'stop',
	back: 'back',
	rewind: 'back',
	forward: 'fwd',
	fwd: 'fwd',
	goto: 'goto',
	next: 'nextch',
	prev: 'prevch',
	chapter: 'chapter',
	speed: 'speed',
	sleep: 'sleep'
};

const SLEEP_WORDS = new Set(['chapter', 'off']);
// Podcast episode titles run to 200 characters; ten of those overran a 2,000-character reply.
const TITLE_MAX = 80;

function clip(text) {
	const s = String(text);
	return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1) + '…' : s;
}

function chapterList(ctx) {
	const s = ctx.bot.books.session(ctx.guildId);
	if (!s) return 'No book is playing in this server.';
	const chs = bookModel.chapters(s.work);
	const current = bookModel.chapterAt(s.work, ctx.bot.books.position(s));
	const at = current ? current.number - 1 : 0;
	const from = Math.max(0, Math.min(at - 4, chs.length - 10));
	const lines = chs.slice(from, from + 10).map((c) => {
		const mark = current && c.number === current.number ? '▶' : '•';
		return `${mark} ${c.number} · ${clip(c.title)} (${bookModel.formatSpan(c.endMs - c.startMs)})`;
	});
	return `**${s.work.title}**: ${chs.length} chapter${chs.length === 1 ? '' : 's'}. \`/book chapter <n>\` jumps.\n${lines.join('\n')}`;
}

function speedArg(rest) {
	const x = Number(String(rest).trim().replace(/x$/i, ''));
	return bookModel.SPEEDS.includes(x) ? x : null;
}

function sleepArg(rest) {
	const v = String(rest).trim().toLowerCase().replace(/\s*(m|min|mins|minutes)$/, '');
	if (SLEEP_WORDS.has(v)) return v;
	return /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null;
}

async function run(ctx) {
	const books = ctx.bot.books;
	if (ctx.sub === 'now') {
		const r = books.repost(ctx.guildId, { textChannel: ctx.textChannel });
		return ctx.say(r.text);
	}
	const action = CONTROL[ctx.sub];
	let arg;
	switch (action) {
		case 'back':
		case 'fwd':
			arg = ctx.rest || undefined;
			break;
		case 'goto':
			if (!ctx.rest) return ctx.say('Go to where? Try `1:23:45`, `+5m` or `-90`.');
			arg = ctx.rest;
			break;
		case 'chapter':
			if (!ctx.rest) return ctx.say(chapterList(ctx));
			if (!/^\d+$/.test(ctx.rest)) return ctx.say('Which chapter? Give its number; `/book chapter` lists them.');
			arg = Number(ctx.rest);
			break;
		case 'speed':
			arg = speedArg(ctx.rest);
			if (arg === null) return ctx.say(`Speed must be one of ${bookModel.SPEEDS.map(x => `${x}x`).join(', ')}.`);
			break;
		case 'sleep':
			arg = sleepArg(ctx.rest);
			if (arg === null) return ctx.say('Sleep after how long? Give minutes, `chapter` or `off`.');
			break;
		default:
			break;
	}
	const r = books.control(ctx.guildId, ctx.member, action, arg);
	return ctx.say(r.text);
}

module.exports = { names: [...Object.keys(CONTROL), 'now'], run, speedArg, sleepArg };
