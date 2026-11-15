// helpers/apMediaAutoskip.js
// Locked playlist songs in voice: which queue entries the bot may skip for the Plex Media game, and
// the line and the command-log event that report a stretch of skips.
//
// Whether a song is locked is the game's to say (helpers/apMediaGame.js lockedFor, which reaches
// app/bot.js as bot.autoskip while the game runs): only the game knows each slot's inventory. The bot
// asks before it joins voice or opens a stream, so a skipped song costs neither, and it reports what
// it skipped once per stretch of skips, as the next song starts or playback ends.

const { escapeMarkdown } = require('discord.js');

const ICON = '\u23ED\uFE0F';
const SHOWN = 3;
// entries.py lets a title run to 1,000 characters, and Discord refuses a message over 2,000 whole.
const NAME_MAX = 100;
const ELLIPSIS = '\u2026';
// The command log cuts a value at 300 characters, so more songs than this would only be cut off.
const LOGGED_SONGS = 20;

/**
 * Whether the autoskip may skip this queue entry at all: a Plex track about to play for the first
 * time. A secret clip (Hitster's, a trap's Commercial Break) has to play, a YouTube entry has no
 * Plex identity to look up, and a song a !seek or a Rewind replays is the song already playing. So is
 * a !loop's once it has played (app/bot.js marks it `played`), but a !loop set on a song still
 * waiting at the head of the queue would otherwise let it past the check.
 * @param {object} entry a Bot queue entry
 * @returns {boolean}
 */
function skippable(entry) {
	return !!entry && !entry.secret && !!entry.key && !entry.isSeeking && !(entry.replay && entry.played);
}

function clip(text, max) {
	const chars = [...String(text ?? '')];
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}${ELLIPSIS}` : chars.join('');
}

// escapeMarkdown leaves a masked link [text](url) working, so every [ is escaped too, as the game's
// own lines do.
function md(text) {
	return escapeMarkdown(clip(text, NAME_MAX)).replace(/\[/g, '\\[');
}

function code(name) {
	return `\`${String(name ?? '').replace(/`/g, "'")}\``;
}

// "A, B, C and 2 more playlists": `nouns` is the [one, many] spelling of what is counted, if any.
function named(items, nouns = null) {
	const shown = items.slice(0, SHOWN);
	const more = items.length - shown.length;
	if (more) return `${shown.join(', ')} and ${more} more${nouns ? ` ${nouns[more === 1 ? 0 : 1]}` : ''}`;
	return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown.join('');
}

function addAll(into, values) {
	for (const value of Array.isArray(values) ? values : []) {
		const s = String(value ?? '');
		if (s && !into.includes(s)) into.push(s);
	}
}

function textOf(value) {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// Each slot and playlist once, in the order the skips came.
function namesOf(skips) {
	const slots = [];
	const playlists = [];
	for (const skip of skips) {
		addAll(slots, skip && skip.slots);
		addAll(playlists, skip && skip.playlists);
	}
	return { slots, playlists };
}

/**
 * The line for one stretch of skipped songs: "Skipped 2 songs still locked in Road Trip on
 * `ZackPlex`'s list: **Song A** and **Song D**.", naming three songs, slots and playlists at most.
 * It says where each song is locked, which need not be where it was queued from.
 * @param {Array<{title?: string, slots?: string[], playlists?: string[]}>} skips one per song skipped:
 *   its title, and the slots and playlists bot.autoskip gave for it
 * @returns {string}
 */
function lineFor(skips) {
	const { slots, playlists } = namesOf(skips);
	const n = skips.length;
	const where = [];
	if (playlists.length) where.push(`in ${named(playlists.map(md), ['playlist', 'playlists'])}`);
	if (slots.length === 1) where.push(`on ${code(slots[0])}'s list`);
	else if (slots.length > 1) where.push(`on the lists of ${named(slots.map(code))}`);
	const songs = `song${n === 1 ? '' : 's'}`;
	const head = where.length ? `Skipped ${n} ${songs} still locked ${where.join(' ')}` : `Skipped ${n} locked ${songs}`;
	const titles = skips.map((skip) => textOf(skip && skip.title)).filter(Boolean);
	const shown = titles.slice(0, SHOWN).map((title) => `**${md(title)}**`);
	const more = n - shown.length;
	let tail = '';
	if (shown.length) tail = more ? `: ${shown.join(', ')} and ${more} more` : `: ${named(shown)}`;
	return `${ICON} ${head}${tail}.`;
}

/**
 * The command-log event ('track-locked') for one stretch of skipped songs: how many, which ("Artist -
 * Title", the first 20), and the slots and playlists they are locked on. One per stretch: an append
 * per song held the bot up for 0.5 to 1 s over a 600-song stretch, on its disk writes alone.
 * @param {Array<{title?: string, artist?: string, slots?: string[], playlists?: string[]}>} skips
 * @returns {{count: number, songs: string, slots: string, playlists: string}}
 */
function eventFor(skips) {
	const { slots, playlists } = namesOf(skips);
	const songs = [];
	for (const skip of skips) {
		if (songs.length >= LOGGED_SONGS) break;
		const title = textOf(skip && skip.title);
		const artist = textOf(skip && skip.artist);
		const song = artist && title ? `${artist} - ${title}` : title || artist;
		if (song) songs.push(song);
	}
	return { count: skips.length, songs: songs.join('; '), slots: slots.join(', '), playlists: playlists.join(', ') };
}

module.exports = { skippable, lineFor, eventFor };
