// commands/book.js: /book and !book (alias !books), the audiobook and podcast player.
//
// This file holds the slash spec, autocomplete, the sub-help and the dispatch. The subcommands
// live in play.js, controls.js, library.js, admin.js, text.js, marks.js and edit.js, each exporting
// { names, run(ctx) }, and are required explicitly (not by a directory scan) so a stray file can
// never become a command.
//
// Replies go through say(): the first is message.reply (on slash, the editReply that closes the
// ephemeral defer), later ones are an ephemeral followUp on slash and a channel message on
// prefix. The interaction adapter would post a slash command's second reply publicly.

const { EmbedBuilder } = require('discord.js');
const config = require('../../config/config.js');
const logger = require('../../helpers/logger.js');
const bookModel = require('../../helpers/bookModel.js');
const { chapterLabel } = require('../../helpers/bookChapterLabel.js');

const play = require('./play.js');
const controls = require('./controls.js');
const library = require('./library.js');
const admin = require('./admin.js');
const text = require('./text.js');
const marks = require('./marks.js');
const edit = require('./edit.js');

const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };
const CHOICE_MAX = 100;
const MAX_CHOICES = 25;

function offText(p = config.commandPrefix || '!') {
	return `📚 Audiobooks are turned off. The bot owner can turn them on with \`${p}config\`, under Audiobooks (\`audiobooksEnabled\`).`;
}

const CONTENT_MAX = 2000;

// No prototype: `!book constructor` would otherwise find Object and throw instead of answering.
const HANDLERS = Object.create(null);
for (const mod of [play, controls, library, admin, text, marks, edit]) {
	for (const name of mod.names) HANDLERS[name] = mod;
}

const SPEED_CHOICES = bookModel.SPEEDS.map(x => ({ name: `${x}x`, value: String(x) }));
const SLEEP_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90].map(m => ({ name: `${m} min`, value: String(m) }))
	.concat([{ name: 'End of this chapter', value: 'chapter' }, { name: 'Off', value: 'off' }]);
const SECONDS_CHOICES = [[10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']]
	.map(([value, name]) => ({ name, value }));

const EDIT_FIELD_CHOICES = [
	['title', 'title'], ['author', 'author'], ['narrator', 'narrator'], ['publisher', 'publisher'],
	['series (this title)', 'series'], ['series (all the author\'s books)', 'author-series'],
	['clear an edit', 'clear'], ['exclude from the catalog', 'exclude'], ['include again', 'include'], ['look up online', 'lookup']
].map(([name, value]) => ({ name, value }));

const TITLE = (description, required = false) => ({ name: 'title', type: 'STRING', description, required, autocomplete: true });

const SUBCOMMANDS = [
	{ name: 'play', description: 'Start or resume an audiobook or podcast in your voice channel',
		options: [TITLE('Book or podcast (empty resumes your latest)'),
			{ name: 'from-start', type: 'BOOLEAN', description: 'Start from the beginning instead of your place', flag: '--restart' }] },
	{ name: 'pause', description: 'Pause the book (your place is kept)' },
	{ name: 'resume', description: 'Resume the paused book' },
	{ name: 'stop', description: 'Stop the book and leave voice (your place is saved)' },
	{ name: 'back', description: 'Jump back',
		options: [{ name: 'seconds', type: 'INTEGER', description: 'How far (default 30 s)', choices: SECONDS_CHOICES }] },
	{ name: 'forward', description: 'Jump forward',
		options: [{ name: 'seconds', type: 'INTEGER', description: 'How far (default 30 s)', choices: SECONDS_CHOICES }] },
	{ name: 'goto', description: 'Go to a time in the book: 1:23:45, or +5m / -90 from here',
		options: [{ name: 'time', type: 'STRING', description: '1:23:45 from the start, or +5m / -90 relative', required: true }] },
	{ name: 'chapter', description: 'Jump to a chapter, or list the chapters around this one',
		options: [{ name: 'number', type: 'INTEGER', description: 'Chapter number', autocomplete: true }] },
	{ name: 'speed', description: 'Playback speed (pitch stays the same; saved per book)',
		options: [{ name: 'rate', type: 'STRING', description: 'Speed', required: true, choices: SPEED_CHOICES }] },
	{ name: 'sleep', description: 'Sleep timer: stop after some listening, or at the end of the chapter',
		options: [{ name: 'after', type: 'STRING', description: 'When to stop', required: true, choices: SLEEP_CHOICES }] },
	{ name: 'now', description: 'Post the book card again at the bottom of the channel' },
	{ name: 'shelf', description: 'Your books in progress and finished' },
	{ name: 'library', description: 'Every audiobook and podcast the bot knows',
		options: [{ name: 'filter', type: 'STRING', description: 'Only titles, authors or series matching this' }] },
	{ name: 'stats', description: 'Listening stats',
		options: [{ name: 'user', type: 'USER', description: 'Whose stats (default yours)', omitFromQuery: true }] },
	{ name: 'leaderboard', description: 'Hours listened in this server' },
	{ name: 'finish', description: 'Mark a book finished',
		options: [TITLE('Book (default the one you are listening to)')] },
	{ name: 'forget', description: 'Forget your place in a book (asks first)',
		options: [TITLE('Book', true)] },
	{ name: 'text', description: 'Read along: the book\'s text in your DMs, following the narration',
		options: [{ name: 'mode', type: 'STRING', description: 'on, off or now (empty: status)',
			choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }, { name: 'now', value: 'now' }] }] },
	{ name: 'marks', description: 'Read along: the sync marks set on a book with 📌',
		options: [TITLE('Book (default the one playing)')] },
	{ name: 'unmark', description: 'Remove your latest sync mark, a listed one, or (owner) all of a book\'s',
		options: [{ name: 'which', type: 'STRING', description: 'A number from /book marks, or all confirm (owner)' }, TITLE('Book (default the one playing)')] },
	{ name: 'link', description: 'Owner: tie a book to its ebook (Calibre id, ISBN, EPUB path, off, auto)',
		options: [TITLE('Book', true), { name: 'ebook', type: 'STRING', description: 'Calibre id, ISBN, EPUB path, off or auto (empty: show)' }] },
	{ name: 'rescan', description: 'Owner: re-read the audiobook library from Plex now' },
	{ name: 'edit', description: 'Owner: fix a book\'s title, author, narrator or series (your edit wins)',
		options: [TITLE('Book', true),
			{ name: 'field', type: 'STRING', description: 'What to change (empty: show where each detail came from)', choices: EDIT_FIELD_CHOICES },
			{ name: 'value', type: 'STRING', description: 'The new value, or none; for clear, the detail to clear' },
			{ name: 'position', type: 'STRING', description: 'Number in the series, like 2 or 0.5 (series only)' }] }
];

function fences(text) {
	return (text.match(/```/g) || []).length;
}

// By code point, so an emoji is never cut in half. An odd fence count would leave the ellipsis,
// and everything after it in the client, inside a code block.
function clipContent(text) {
	if (text.length <= CONTENT_MAX) return text;
	const take = (budget) => {
		let out = '';
		for (const ch of text) {
			if (out.length + ch.length > budget) break;
			out += ch;
		}
		return out;
	};
	let out = take(CONTENT_MAX - 1);
	if (fences(out) % 2) {
		out = take(CONTENT_MAX - 1 - '\n```\n'.length);
		if (fences(out) % 2) out += '\n```\n';
	}
	return out + '…';
}

/**
 * Message-shaped replies that never reject and never ping.
 * @param {object} message a Message or the interaction adapter
 * @param {{ ephemeral: boolean }} opts whether slash follow-ups are private
 */
function makeSay(message, { ephemeral = true } = {}) {
	let first = true;
	return async function say(payload) {
		const body = Object.assign(typeof payload === 'string' ? { content: payload } : Object.assign({}, payload), { allowedMentions: NO_PINGS });
		// Discord rejects the whole reply over the limit, and on slash the first reply is the only
		// thing that closes the "thinking…" defer.
		if (typeof body.content === 'string') body.content = clipContent(body.content);
		try {
			if (first) {
				first = false;
				return await message.reply(body);
			}
			if (message.interaction) {
				return await message.interaction.followUp(ephemeral ? Object.assign(body, { flags: EPHEMERAL }) : body);
			}
			return await message.channel.send(body);
		} catch (err) {
			logger.warn('/book could not reply:', (err && err.message) || err);
			return null;
		}
	};
}

// Turning audiobooks off does not end a book already playing, so its controls stay reachable.
function liveSession(bot, message) {
	const guildId = message.guild ? message.guild.id : null;
	return !!(guildId && bot && bot.books && bot.books.session(guildId));
}

function catalogStore() {
	return require('../../helpers/bookCatalogStore.js');
}

function bookmarkStore() {
	return require('../../helpers/bookmarks.js');
}

function norm(text) {
	return require('../../helpers/bookCatalog.js').norm(text);
}

function suffixOf(work) {
	if (work.edition) return ` (${work.edition})`;
	if (work.narrator) return ` (read by ${work.narrator})`;
	return '';
}

/**
 * finish and forget: an id, an alias or free text. Editions that share a title stay ambiguous
 * unless only one of them has your bookmark.
 * @returns {{ work?: object, id?: string, title?: string, error?: string }}
 */
function resolveWork(text, userId, { includeMissing = false } = {}) {
	const q = String(text || '').trim();
	if (!q) return { error: 'Which book? Give its title; `/book shelf` lists yours.' };
	const store = catalogStore();
	const exact = store.work(q);
	if (exact) return { work: exact, id: exact.id, title: exact.title };
	const marks = bookmarkStore().forUser(String(userId));
	if (includeMissing) {
		const mark = marks.find(m => m.workId === q);
		if (mark) return { id: mark.workId, title: mark.title };
	}
	const hits = store.findWorks(q) || [];
	if (!hits.length) return { error: `Nothing in the audiobook library matches "${q}".` };
	const sameTitle = hits.filter(w => norm(w.title) === norm(q));
	const pool = sameTitle.length ? sameTitle : hits;
	const mine = pool.filter(w => marks.some(m => m.workId === w.id));
	const one = pool.length === 1 ? pool[0] : mine.length === 1 ? mine[0] : null;
	if (one) return { work: one, id: one.id, title: one.title };
	const lines = pool.slice(0, 5).map(w => `• \`${w.id}\` ${w.title}${suffixOf(w)}`);
	return { error: `Which one? Use the id:\n${lines.join('\n')}` };
}

function helpEmbed(bot) {
	const p = (bot && bot.config && bot.config.commandPrefix) || config.commandPrefix;
	return new EmbedBuilder()
		.setColor('#2ECC71')
		.setTitle('📚 AUDIOBOOKS AND PODCASTS')
		.setDescription(
			'Your place is saved per book and per person. Everything works as `/book …` too.\n\n' +
			'**▶️ LISTENING**\n' +
			`> \`${p}book play [title] [--restart]\` — Start or resume a book in your voice channel (no title: your latest).\n` +
			`> \`${p}book pause\` / \`${p}book resume\` / \`${p}book stop\` — Stop saves your place and leaves voice.\n` +
			`> \`${p}book now\` — Post the book card again at the bottom.\n\n` +
			'**⏩ MOVING AROUND**\n' +
			`> \`${p}book back [90|1:30|2m]\` / \`${p}book forward [...]\` — Jump (default 30 s).\n` +
			`> \`${p}book goto [1:23:45|+5m|-90]\` — Go to a time, or move relative to here.\n` +
			`> \`${p}book chapter [n]\` / \`${p}book next\` / \`${p}book prev\` — Chapters (no number lists them).\n` +
			`> \`${p}book speed [0.75-3]\` / \`${p}book sleep [minutes|chapter|off]\` — Speed and sleep timer.\n\n` +
			'**📜 READ ALONG**\n' +
			`> \`${p}book text on\` / \`${p}book text off\` — The book's text in your DMs, a page at a time, turning with the narration. Approximate: chapter-level at best.\n` +
			`> \`${p}book text\` — Is there text for your book, and where it comes from. \`${p}book text now\` sends the page again.\n` +
			'> 📖 on the book card — The page right now, visible only to whoever pressed it: the listener, or anyone in the book\'s voice channel.\n' +
			'> 📌 on your DM page — Press it as the narrator reaches the page\'s first words: the text snaps to the voice there, for everyone who plays that recording.\n' +
			`> \`${p}book marks [title]\` / \`${p}book unmark [n]\` — List a book's marks; remove your latest or a listed one. \`${p}book unmark all [title] confirm\` (owner) clears a book.\n` +
			`> \`${p}book link <title> <calibre id|isbn|path|off|auto>\` — Owner: tie a book to its ebook.\n\n` +
			'**📖 YOUR BOOKS**\n' +
			`> \`${p}book shelf\` — In progress and finished, with Resume buttons.\n` +
			`> \`${p}book library [filter]\` — Every book and podcast the bot knows.\n` +
			`> \`${p}book stats [@user]\` / \`${p}book leaderboard\` — Hours listened.\n` +
			`> \`${p}book finish [title]\` / \`${p}book forget [title] confirm\` — Mark finished, or drop your place.\n` +
			`> \`${p}book rescan\` — Owner: re-read the library from Plex.\n` +
			`> \`${p}book edit <title> [detail value]\` — Owner: fix a title, author, narrator or series, or take a book out. \`${p}book edit\` lists the forms.`
		);
}

// ---- autocomplete (memory only: the catalog and bookmark stores, never Plex) ---------------

function choice(name, value) {
	return { name: name.length > CHOICE_MAX ? name.slice(0, CHOICE_MAX - 1) + '…' : name, value };
}

function titleChoices(userId, typed, sub) {
	if (!config.audiobooksEnabled) return [choice('Audiobooks are turned off (the bot owner can turn them on in /config)', 'off')];
	const store = catalogStore();
	const all = store.works() || [];
	if (!all.length) return [choice('📚 The audiobook library is still being read. Try again in a moment.', 'loading')];
	const hits = String(typed || '').trim() ? store.findWorks(typed) || [] : all;
	const marks = bookmarkStore().forUser(String(userId));
	const markOf = new Map(marks.map(m => [m.workId, m]));
	const out = [];
	const seen = new Set();
	const push = (id, name) => {
		if (seen.has(id) || id.length > CHOICE_MAX || out.length >= MAX_CHOICES) return;
		seen.add(id);
		out.push(choice(name, id));
	};
	const hitIds = new Set(hits.map(w => w.id));
	for (const mark of marks) {
		if (mark.finished || !hitIds.has(mark.workId)) continue;
		const work = store.work(mark.workId);
		const total = bookModel.totalMs(work);
		const pct = total > 0 ? Math.floor((mark.absoluteMs / total) * 100) : 0;
		push(work.id, `▶ ${pct}% · ${work.title}${suffixOf(work)}`);
	}
	for (const w of hits) push(w.id, `${w.title}${suffixOf(w)}${w.author ? ` · ${w.author}` : ''}`);
	if (sub === 'forget') {
		const q = norm(typed || '');
		for (const mark of marks) {
			if (store.work(mark.workId)) continue;
			if (q && !norm(mark.title).includes(q)) continue;
			push(mark.workId, `⚠️ ${mark.title} (not in the library any more)`);
		}
	}
	return out;
}

function chapterChoices(bot, guildId, typed) {
	const s = bot && bot.books && guildId ? bot.books.session(guildId) : null;
	if (!s) return [];
	const chs = bookModel.chapters(s.work);
	if (!chs.length) return [];
	const current = bookModel.chapterAt(s.work, bot.books.position(s));
	const t = String(typed || '').trim();
	// The number stays first because it is what /book chapter jumps to; the label says what the
	// track names ("240 · Book 4 · Chapter 7"), where a slot number alone counts files.
	const labelOf = (c) => {
		try {
			return chapterLabel(s.work, c, chs).label || c.title;
		} catch (_) {
			return c.title;
		}
	};
	let list = chs;
	let centre = current ? current.number : 1;
	if (/^\d+$/.test(t)) centre = Number(t);
	else if (t) list = chs.filter(c => norm(c.title).includes(norm(t)) || norm(labelOf(c)).includes(norm(t)));
	const at = Math.max(0, list.findIndex(c => c.number >= centre));
	const from = Math.max(0, Math.min(at - Math.floor(MAX_CHOICES / 2), list.length - MAX_CHOICES));
	return list.slice(from, from + MAX_CHOICES).map(c => {
		const mark = current && c.number === current.number ? '▶ ' : '';
		return choice(`${mark}${c.number} · ${labelOf(c)} (${bookModel.formatSpan(c.endMs - c.startMs)})`, c.number);
	});
}

async function autocomplete(interaction, bot) {
	let choices = [];
	try {
		const focused = interaction.options.getFocused(true);
		let sub = null;
		try { sub = interaction.options.getSubcommand(false); } catch (_) {}
		if (focused.name === 'number') choices = chapterChoices(bot, interaction.guildId, focused.value);
		else if (focused.name === 'title') choices = titleChoices(interaction.user && interaction.user.id, focused.value, sub);
	} catch (err) {
		logger.warn('/book autocomplete failed:', (err && err.message) || err);
		choices = [];
	}
	try { await interaction.respond(choices.slice(0, MAX_CHOICES)); } catch (_) {}
}

module.exports = {
	name: 'book',
	aliases: ['books'],
	command: {
		usage: '<play|pause|resume|stop|back|forward|goto|chapter|speed|sleep|now|shelf|library|stats|leaderboard|finish|forget|text|link|marks|unmark|rescan|edit>',
		description: 'Audiobooks and podcasts with a saved place per person. Type "!book ?" for more help.',
		slash: {
			description: 'Audiobooks and podcasts: play, resume, chapters, speed, sleep timer, your shelf',
			// Only the leaderboard is for the channel; everything else is about you.
			ephemeral: i => i.options.getSubcommand(false) !== 'leaderboard',
			subcommands: SUBCOMMANDS,
			autocomplete
		},
		process: async function(bot, client, message, query) {
			const text = String(query || '').trim();
			const first = text.split(/\s+/)[0] || '';
			const sub = first.toLowerCase();
			if (!text || sub === '?' || sub === 'help') {
				try {
					await message.channel.send({ embeds: [helpEmbed(bot)] });
				} catch (err) {
					logger.warn('Could not send the /book help:', (err && err.message) || err);
				}
				return;
			}
			const say = makeSay(message, { ephemeral: sub !== 'leaderboard' });
			const handler = HANDLERS[sub];
			if (!handler) return say(`Unknown book command "${first}". \`${config.commandPrefix}book ?\` lists them.`);
			if (!config.audiobooksEnabled && !(handler === controls && liveSession(bot, message))) return say(offText((bot && bot.config && bot.config.commandPrefix) || undefined));
			if (!bot || !bot.books) return say('📚 The audiobook player failed to load; check the bot log.');
			const interaction = message.interaction || null;
			return handler.run({
				bot,
				client,
				message,
				interaction,
				sub,
				rest: text.slice(first.length).trim(),
				guild: message.guild || null,
				guildId: message.guild ? message.guild.id : null,
				member: message.member || null,
				userId: message.author ? String(message.author.id) : null,
				textChannel: interaction ? interaction.channel : message.channel,
				say,
				resolveWork
			});
		}
	}
};

module.exports._internal = { makeSay, resolveWork, titleChoices, chapterChoices, helpEmbed, offText, SUBCOMMANDS };
