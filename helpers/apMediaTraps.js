// helpers/apMediaTraps.js
// The Plex Media traps that act on what the bot plays: Commercial Break, Shuffle Mode, Rewind,
// Intermission and Slow Motion, on the music queue or on the listener's own audiobook.
//
// helpers/apMediaGame.js owns everything about a trap except its effect: arming, the 12 h fizzle,
// persistence and the announcements. It asks listening(userId) whether the slot's person hears the
// bot right now and apply() runs the effect. Nothing here reads or writes the game's store.
//
// Rules every effect keeps:
// - One effect at a time per guild, and none on music while Hitster holds the guild's voice or the
//   head of the queue loops, waits on a seek or is itself a secret clip.
// - Music speed never changes. Voice credit compares the audio that went out with the track's
//   length (helpers/apMediaVoice.js), so a slowed track could never count whole, and the strict
//   heard ranges would stretch. Slow Motion on music is a pause.
// - A pause is lifted only on the player or session it paused, and only while that pause is still
//   the trap's. Anyone may resume early, and a pause anyone makes, during the trap's or after it,
//   is theirs.
// - A clip goes in after the current track, never in front of it. A run that replaces the playing
//   player restarts the interrupted track from 0 and its partial listen is lost (app/bot.js
//   runPlayback), which is what a Hitster clip does to music.
// - A book's speed goes back only while it is still the trap's 0.75x. The speed is saved into the
//   bookmark and becomes the default of the listener's next new book (bookmarks.lastSpeed), so a
//   restore that finds no session puts the bookmark's speed back instead, and only its speed: that
//   book must not become the newest one /book play resumes.
//
// Book controls go through the director's controlSession with the session's own listener as the
// actor: canControl lets the listener do everything, which is what a trap acting on their book
// needs, and it leaves the engine's own paths (card edits, saves, change events) unchanged.

const { AudioPlayerStatus } = require('@discordjs/voice');
const contracts = require('./apMediaContracts.js');
const bookModel = require('./bookModel.js');
const defaultLogger = require('./logger.js');

const VOICE_TRAPS = Object.freeze(['commercial_break', 'shuffle_mode', 'rewind', 'intermission', 'slow_motion']);

const SLOW_SPEED = 0.75;
const SLOW_MS = 10 * 60 * 1000;
const BREAK_MS = 30 * 1000;
const INTERMISSION_MS = 60 * 1000;
const BOOK_BACK_MS = 5 * 60 * 1000;
// A playlist row longer than this is a song, not a commercial.
const CLIP_MAX_MS = 3 * 60 * 1000;
const CLIP_SCAN = 200;
// Only for the end line and to free the guild: a clip leaves the queue when it has played or when
// someone removes it, and neither is announced to anything here.
const CLIP_POLL_MS = 15 * 1000;
// A session still joining refuses every control but stop, for about a second.
const START_RETRY_MS = 5 * 1000;
const START_RETRIES = 6;

const CLIP_TITLE = 'Commercial Break';
const CLIP_ARTIST = 'Plex Media';
const TV = '\u{1F4FA}';

const LINE = Object.freeze({
	clip: 'a commercial plays after this track',
	clipPause: `${TV} Commercial break, the music pauses for 30 seconds`,
	shuffled: 'the queue is shuffled',
	shortQueue: 'too few tracks to shuffle, so this track starts over',
	restart: 'this track starts over',
	noRestart: 'this track cannot start over, so the music pauses for 30 seconds',
	intermission: 'the music pauses for 60 seconds, or until someone resumes it',
	musicSlow: 'music never slows down, so it pauses for 30 seconds',
	bookBreak: 'the book pauses for 30 seconds',
	bookIntermission: 'the book pauses for 60 seconds',
	bookBack: 'back 5 minutes',
	bookStart: 'back to the start',
	bookShuffle: 'a book has nothing to shuffle, so it goes back 5 minutes',
	bookShuffleStart: 'a book has nothing to shuffle, so it goes back to the start',
	slow: '0.75x for 10 minutes',
	alreadySlow: 'already at 0.75x, so the book pauses for 30 seconds',
});

const END_LINE = Object.freeze({
	musicDone: 'the music plays again',
	musicEarly: 'someone resumed the music early',
	musicPaused: 'someone paused the music, so it stays paused',
	musicGone: 'the paused track was stopped',
	bookDone: 'the book plays again',
	bookEarly: 'the book was resumed early',
	bookPaused: 'someone paused the book, so it stays paused',
	bookGone: 'the book was stopped',
	bookAway: 'the book stays paused until its listener is back in voice',
	clip: 'the commercial is over',
	speedNone: 'no bookmark was left to put back',
});

const DEFAULT_TIMERS = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h),
};

// Shared by every runner of the process: a late notice from a runner the game has replaced can
// never carry the id of an effect of the new one.
let lastEffectId = 0;

function why(err) {
	return (err && err.message) || err;
}

function refused(reason) {
	return { applied: false, reason };
}

function partKey(row) {
	const media = row && Array.isArray(row.Media) ? row.Media[0] : null;
	const part = media && Array.isArray(media.Part) ? media.Part[0] : null;
	return part && typeof part.key === 'string' && part.key ? part.key : null;
}

function isClip(row) {
	const ms = Number(row && row.duration);
	return !!row && row.type === 'track' && !!partKey(row) && Number.isFinite(ms) && ms > 0 && ms <= CLIP_MAX_MS;
}

function statusOf(player) {
	return player && player.state ? player.state.status : null;
}

function memberIdOf(member) {
	if (!member) return '';
	return String(member.id || (member.user && member.user.id) || '');
}

/**
 * @param {object} opts
 * @param {() => object|null} opts.getBot app/bot.js's Bot, read on every call: !restart builds a new one
 * @param {() => object|null} [opts.getBooks] helpers/bookEngine.js's director; default getBot().books
 * @param {object|(() => object)} [opts.pms] helpers/apMediaPlex.js createPms(): playlists, playlistItems
 * @param {object|(() => object)} [opts.settings] the live config: apMediaTraps, apMediaVoiceTraps and
 *   apMediaTrapClips (a playlist title or ratingKey; blank means no clips)
 * @param {object} [opts.logger] @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @param {() => number} [opts.now]
 * @param {(info: {id?: number, userId: string, slot: *, kind: string, where: 'music'|'book',
 *   line: string, how: 'done'|'early'|'paused'|'gone'|'away'|'overdue', speed?: true}) => void} [opts.onEnd]
 *   told when a running effect ends by itself (its time ran out, someone resumed it early or paused
 *   it themselves, the track or book went away). Never for end() or stop(), whose caller knows
 *   already. `id` is the one apply() returned for that effect. A Slow Motion speed put back says
 *   `speed: true` and carries no id.
 * @param {object} [opts.voiceClaims] helpers/voiceClaims.js @param {object} [opts.bookmarks]
 *   helpers/bookmarks.js @param {object} [opts.catalog] helpers/bookCatalogStore.js
 * @param {() => number} [opts.random] picks the clip
 */
function createTrapRunner(opts = {}) {
	const {
		getBot,
		getBooks,
		pms = null,
		settings = null,
		logger = null,
		timers = null,
		now = Date.now,
		onEnd = null,
		voiceClaims = null,
		bookmarks = null,
		catalog = null,
		random = Math.random,
	} = opts;

	// Effects that hold a guild, by guild id. A Slow Motion lock lasts while its session does; its
	// restore lives in `restores`, which also carries the ones re-armed after a restart.
	const running = new Map();
	const restores = new Map();
	const warned = new Set();
	let generation = 0;

	const log = () => {
		const l = typeof logger === 'function' && typeof logger.warn !== 'function' ? logger() : logger;
		return l && typeof l.warn === 'function' ? l : defaultLogger;
	};
	const rand = typeof random === 'function' ? random : Math.random;
	const tm = () => {
		const t = typeof timers === 'function' && typeof timers.setTimeout !== 'function' ? timers() : timers;
		return t && typeof t.setTimeout === 'function' ? t : DEFAULT_TIMERS;
	};
	const plex = () => (typeof pms === 'function' && typeof pms.playlistItems !== 'function' ? pms() : pms);
	const claims = () => voiceClaims || require('./voiceClaims.js');
	const marks = () => bookmarks || require('./bookmarks.js');
	const works = () => catalog || require('./bookCatalogStore.js');

	function bot() {
		try {
			return typeof getBot === 'function' ? getBot() || null : null;
		} catch (_) {
			return null;
		}
	}

	function books() {
		try {
			if (typeof getBooks === 'function') return getBooks() || null;
			const b = bot();
			return (b && b.books) || null;
		} catch (_) {
			return null;
		}
	}

	function config() {
		try {
			let c = typeof settings === 'function' ? settings() : settings;
			if (!c) c = require('../config/config.js');
			return c && typeof c === 'object' ? c : {};
		} catch (_) {
			return {};
		}
	}

	function enabled() {
		const c = config();
		return c.apMediaTraps !== false && c.apMediaVoiceTraps !== false;
	}

	function clipSetting() {
		const v = config().apMediaTrapClips;
		return v === undefined || v === null ? '' : String(v).trim();
	}

	function later(ms, fn) {
		const handle = tm().setTimeout(() => {
			try {
				fn();
			} catch (err) {
				log().warn('Plex Media: a trap timer failed:', why(err));
			}
		}, Math.max(0, ms));
		if (handle && typeof handle.unref === 'function') handle.unref();
		return handle;
	}

	function clear(handle) {
		if (!handle) return;
		try {
			tm().clearTimeout(handle);
		} catch (_) {}
	}

	function warnOnce(key, text) {
		if (warned.has(key)) return;
		warned.add(key);
		log().warn(text);
	}

	// Inside a player's state change or the engine's notify: a throw there lands in voice's audio
	// cycle or in the middle of a park, so the game hears of it a turn later.
	function announceEnd(info) {
		if (typeof onEnd !== 'function') return;
		Promise.resolve()
			.then(() => onEnd(info))
			.catch((err) => log().warn('Plex Media: a trap end line failed:', why(err)));
	}

	function claimed(guildId, ignore) {
		try {
			return !!claims().holder(guildId, { ignore });
		} catch (_) {
			return false;
		}
	}

	// --- who is listening -------------------------------------------------------------------

	function sessionById(d, id) {
		if (!d || !id) return null;
		if (typeof d.sessionById === 'function') return d.sessionById(id) || null;
		return (typeof d.sessions === 'function' ? d.sessions() : []).find((s) => s && s.id === id) || null;
	}

	function playingSession(d, userId) {
		if (!d || typeof d.sessions !== 'function') return null;
		return d.sessions().find((s) => s && String(s.userId) === userId && s.state === 'playing') || null;
	}

	/**
	 * Whether this person hears the bot right now: their own audiobook playing, or music playing in the
	 * voice channel they are in, not deafened.
	 * @returns {{where: 'music'|'book', guildId: string, channelId: string|null}|null}
	 */
	function listening(userId) {
		const uid = String(userId ?? '');
		if (!uid) return null;
		const s = playingSession(books(), uid);
		if (s) return { where: 'book', guildId: String(s.guildId), channelId: s.voiceChannelId ? String(s.voiceChannelId) : null };
		const b = bot();
		if (!b || !b.isPlaying || b.isPaused) return null;
		const channel = b.voiceChannel;
		const guild = channel && channel.guild;
		if (!guild || typeof b.voiceListeners !== 'function') return null;
		let ids = [];
		try {
			ids = b.voiceListeners(guild, channel.id) || [];
		} catch (_) {
			return null;
		}
		if (!ids.map(String).includes(uid)) return null;
		return { where: 'music', guildId: String(guild.id), channelId: String(channel.id) };
	}

	// --- the guild lock -----------------------------------------------------------------------

	// A newer Bot (after !restart) owns voice now. No Bot at all only means the game let go of it
	// before stopping this runner, and what the trap did to that Bot is still there to undo.
	function stillOurs(b) {
		const current = bot();
		return !current || current === b;
	}

	function holds(effect) {
		switch (effect.mode) {
			case 'pending':
				return true;
			case 'music-pause':
				return stillOurs(effect.bot) && effect.bot.dispatcher === effect.player && statusOf(effect.player) === AudioPlayerStatus.Paused;
			case 'book-pause': {
				const s = sessionById(effect.books, effect.sessionId);
				return !!s && s.state === 'paused' && s.pausedAt === effect.pausedAt;
			}
			case 'clip':
				return stillOurs(effect.bot) && Array.isArray(effect.bot.songQueue) && effect.bot.songQueue.includes(effect.entry);
			case 'speed': {
				if (!restores.has(effect.key)) return false;
				const s = sessionById(effect.books, effect.sessionId);
				return !!s && s.state !== 'ended';
			}
			default:
				return false;
		}
	}

	function lapseHow(effect) {
		if (effect.mode === 'music-pause') {
			const playing = stillOurs(effect.bot) && effect.bot.dispatcher === effect.player && statusOf(effect.player) === AudioPlayerStatus.Playing;
			return playing ? 'early' : 'gone';
		}
		if (effect.mode === 'book-pause') {
			const s = sessionById(effect.books, effect.sessionId);
			return s && s.state === 'playing' ? 'early' : 'gone';
		}
		return 'done';
	}

	function endLine(effect, how) {
		if (effect.mode === 'clip') return END_LINE.clip;
		const book = effect.mode === 'book-pause';
		if (how === 'done') return book ? END_LINE.bookDone : END_LINE.musicDone;
		if (how === 'early') return book ? END_LINE.bookEarly : END_LINE.musicEarly;
		if (how === 'paused') return book ? END_LINE.bookPaused : END_LINE.musicPaused;
		if (how === 'away') return END_LINE.bookAway;
		return book ? END_LINE.bookGone : END_LINE.musicGone;
	}

	function detach(effect) {
		const off = effect.detach;
		effect.detach = null;
		if (!off) return;
		try {
			off();
		} catch (_) {}
	}

	// 'quiet' for end() and stop(): their caller is the one ending it.
	function settle(effect, how) {
		if (effect.over) return;
		effect.over = true;
		if (running.get(effect.guildId) === effect) running.delete(effect.guildId);
		clear(effect.timer);
		effect.timer = null;
		detach(effect);
		if (how === 'quiet') return;
		announceEnd({ id: effect.id, userId: effect.userId, slot: effect.slot, kind: effect.kind, where: effect.where, line: endLine(effect, how), how });
	}

	function lapse(effect) {
		if (effect.mode === 'speed') {
			if (running.get(effect.guildId) === effect) running.delete(effect.guildId);
			return;
		}
		settle(effect, lapseHow(effect));
	}

	/** The effect holding this guild, after dropping one that no longer holds. */
	function lockOf(guildId) {
		const effect = running.get(guildId);
		if (!effect) return null;
		if (holds(effect)) return effect;
		lapse(effect);
		return null;
	}

	function track(ctx, fields) {
		const effect = {
			id: ++lastEffectId,
			kind: ctx.kind,
			userId: ctx.userId,
			slot: ctx.slot,
			where: ctx.where.where,
			guildId: ctx.where.guildId,
			startedAt: now(),
			timer: null,
			detach: null,
			over: false,
			...fields,
		};
		running.set(effect.guildId, effect);
		return effect;
	}

	// --- music --------------------------------------------------------------------------------

	function musicBlocked(b, where) {
		if (!b || claimed(where.guildId, [])) return true;
		const head = Array.isArray(b.songQueue) ? b.songQueue[0] : null;
		if (!head || head.replay || head.isSeeking || head.secret) return true;
		return statusOf(b.dispatcher) !== AudioPlayerStatus.Playing;
	}

	function liftMusicPause(effect) {
		const b = effect.bot;
		if (!stillOurs(b) || b.dispatcher !== effect.player) return 'gone';
		const st = statusOf(effect.player);
		if (st === AudioPlayerStatus.Playing) return 'early';
		if (st !== AudioPlayerStatus.Paused) return 'gone';
		// commands/pause.js counts every pause it makes; one made under the trap's is theirs to lift.
		if (b.pauseCount !== effect.pauses) return 'paused';
		// Our own unpause emits Playing, which the listener would read as someone resuming early.
		detach(effect);
		b.isPaused = false;
		let ok = false;
		try {
			ok = !!effect.player.unpause();
		} catch (err) {
			log().warn('Plex Media: a trap could not resume the music:', why(err));
		}
		return ok ? 'done' : 'gone';
	}

	function pauseMusic(ctx, b, ms, line) {
		const player = b.dispatcher;
		let took = false;
		try {
			took = !!player.pause(true) || statusOf(player) === AudioPlayerStatus.Paused;
		} catch (err) {
			log().warn('Plex Media: a trap could not pause the music:', why(err));
		}
		if (!took) return refused('busy');
		// The now-playing toggle reads it, and it must say what the player is (commands/pause.js).
		b.isPaused = true;
		const effect = track(ctx, { mode: 'music-pause', bot: b, player, head: b.songQueue[0], until: now() + ms, stops: b.stopGeneration, pauses: b.pauseCount });
		// A resume by anyone ends the trap there and then, so a pause they make later stays theirs.
		// Bot.stop() (!skip, !stop) unpauses before it stops and counts the stop first, so that
		// Playing is told apart from a resume. Idle: a forced stop under the pause, or its stream
		// failing. After a !seek (or on a loop) the same entry plays again at once, unpaused: the
		// music was moved on, not stopped. A newer track's run strips both listeners with
		// removeAllListeners(), and holds() sees that player is no longer current.
		const onPlaying = () => settle(effect, b.stopGeneration !== effect.stops ? 'gone' : 'early');
		const onIdle = () => {
			const current = Array.isArray(b.songQueue) ? b.songQueue[0] : null;
			settle(effect, current && current === effect.head && (current.isSeeking || current.replay) ? 'early' : 'gone');
		};
		player.on(AudioPlayerStatus.Playing, onPlaying);
		player.on(AudioPlayerStatus.Idle, onIdle);
		effect.detach = () => {
			player.removeListener(AudioPlayerStatus.Playing, onPlaying);
			player.removeListener(AudioPlayerStatus.Idle, onIdle);
		};
		effect.timer = later(ms, () => {
			effect.timer = null;
			if (effect.over) return;
			settle(effect, liftMusicPause(effect));
		});
		return { applied: true, line, until: effect.until, id: effect.id };
	}

	function restartTrack(ctx, b, line) {
		const head = b.songQueue[0];
		// takeSeek runs only for Plex tracks; on a YouTube entry the flag would never be read and
		// every end of the track would replay it.
		if (!head.key) return pauseMusic(ctx, b, BREAK_MS, LINE.noRestart);
		head.isSeeking = true;
		head.seekOffset = 0;
		b.isPaused = false;
		try {
			// Forced, as commands/seek.js does: its Idle replays the entry from the seek offset, here 0.
			b.dispatcher.stop(true);
		} catch (err) {
			delete head.isSeeking;
			delete head.seekOffset;
			log().warn('Plex Media: a trap could not restart the track:', why(err));
			return refused('busy');
		}
		return { applied: true, line };
	}

	function shuffleQueue(ctx, b) {
		const queue = b.songQueue;
		if (queue.length < 3) return restartTrack(ctx, b, LINE.shortQueue);
		const rest = queue.slice(1);
		const order = rest.slice();
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.min(i, Math.floor(rand() * (i + 1)));
			[order[i], order[j]] = [order[j], order[i]];
		}
		if (order.every((entry, i) => entry === rest[i])) [order[0], order[1]] = [order[1], order[0]];
		queue.splice(1, rest.length, ...order);
		return { applied: true, line: LINE.shuffled };
	}

	async function findClip(setting) {
		const p = plex();
		if (!p || typeof p.playlistItems !== 'function') return null;
		let ratingKey = /^\d+$/.test(setting) ? Number(setting) : null;
		if (ratingKey === null) {
			const lists = typeof p.playlists === 'function' ? await p.playlists() : [];
			const wanted = setting.toLowerCase();
			const named = (Array.isArray(lists) ? lists : []).filter((l) => l && String(l.title ?? '').trim().toLowerCase() === wanted);
			const pick = named.find((l) => l.playlistType === 'audio') || named[0];
			if (!pick) {
				warnOnce(`missing:${wanted}`, `Plex Media: no Plex playlist is named "${setting}" (apMediaTrapClips), so Commercial Break pauses the music instead.`);
				return null;
			}
			ratingKey = Number(pick.ratingKey);
		}
		if (!Number.isSafeInteger(ratingKey) || ratingKey <= 0) return null;
		const rows = await p.playlistItems(ratingKey, { limit: CLIP_SCAN });
		const clips = (Array.isArray(rows) ? rows : []).filter(isClip);
		if (!clips.length) {
			warnOnce(`empty:${ratingKey}`, `Plex Media: the trap clip playlist ${ratingKey} has no audio tracks of ${CLIP_MAX_MS / 60000} minutes or less, so Commercial Break pauses the music instead.`);
			return null;
		}
		const pick = clips[Math.min(clips.length - 1, Math.floor(rand() * clips.length))];
		return { key: partKey(pick) };
	}

	function watchClip(effect) {
		effect.timer = later(CLIP_POLL_MS, () => {
			effect.timer = null;
			if (effect.over) return;
			if (holds(effect)) watchClip(effect);
			else settle(effect, 'done');
		});
	}

	function dropClip(effect, { skipPlaying }) {
		const b = effect.bot;
		const queue = b && Array.isArray(b.songQueue) ? b.songQueue : [];
		const at = queue.indexOf(effect.entry);
		if (at > 0) {
			queue.splice(at, 1);
			return true;
		}
		if (at === 0 && skipPlaying && stillOurs(b) && b.isPlaying && typeof b.stop === 'function') {
			// The !skip path. A forced player stop would start the next track inside this call.
			b.stop();
			return true;
		}
		return false;
	}

	async function commercialBreak(ctx, b) {
		const setting = clipSetting();
		if (!setting) return pauseMusic(ctx, b, BREAK_MS, LINE.clipPause);
		const gen = generation;
		const hold = track(ctx, { mode: 'pending' });
		let clip = null;
		try {
			clip = await findClip(setting);
		} catch (err) {
			log().warn('Plex Media: the trap clip playlist could not be read:', why(err));
		} finally {
			if (running.get(hold.guildId) === hold) running.delete(hold.guildId);
		}
		if (gen !== generation) return refused('busy');
		// A switch turned off while Plex answered: the game leaves a trap in flight to this answer.
		if (!enabled()) return refused('off');
		// The queue moved on while Plex answered: whatever plays now is the current track.
		const where = listening(ctx.userId);
		if (!where || where.where !== 'music' || where.guildId !== ctx.where.guildId) return refused('absent');
		const now2 = bot();
		if (lockOf(where.guildId) || musicBlocked(now2, where)) return refused('busy');
		const next = { ...ctx, where };
		if (!clip) return pauseMusic(next, now2, BREAK_MS, LINE.clipPause);
		// secret: helpers/apMediaVoice.js credits nothing for it, so no list title is credited or
		// named, and the now-playing card shows only these two words.
		const entry = { title: CLIP_TITLE, artist: CLIP_ARTIST, key: clip.key, secret: true };
		now2.songQueue.splice(1, 0, entry);
		const effect = track(next, { mode: 'clip', bot: now2, entry });
		watchClip(effect);
		return { applied: true, line: LINE.clip, id: effect.id };
	}

	async function applyToMusic(ctx) {
		const b = bot();
		if (musicBlocked(b, ctx.where)) return refused('busy');
		switch (ctx.kind) {
			case 'commercial_break':
				return commercialBreak(ctx, b);
			case 'shuffle_mode':
				return shuffleQueue(ctx, b);
			case 'rewind':
				return restartTrack(ctx, b, LINE.restart);
			case 'intermission':
				return pauseMusic(ctx, b, INTERMISSION_MS, LINE.intermission);
			default:
				return pauseMusic(ctx, b, BREAK_MS, LINE.musicSlow);
		}
	}

	// --- books --------------------------------------------------------------------------------

	function actorOf(s) {
		return s.member && memberIdOf(s.member) === String(s.userId) ? s.member : { id: String(s.userId) };
	}

	function control(d, s, action, arg) {
		try {
			return d.controlSession(s, actorOf(s), action, arg) || { ok: false, code: 'error' };
		} catch (err) {
			log().warn(`Plex Media: a trap could not ${action} the book:`, why(err));
			return { ok: false, code: 'error' };
		}
	}

	function controlRefused(r) {
		return refused(r && r.code === 'no-session' ? 'absent' : 'busy');
	}

	// Only when the guild's voice cache says so, as the engine's listenerAway() reads it.
	function listenerAway(s) {
		const cache = s.guild && s.guild.voiceStates && s.guild.voiceStates.cache;
		if (!cache || typeof cache.get !== 'function') return false;
		const vs = cache.get(String(s.userId));
		return !vs || vs.channelId !== s.voiceChannelId;
	}

	function liftBookPause(effect) {
		const s = sessionById(effect.books, effect.sessionId);
		if (!s || s.state === 'ended') return 'gone';
		if (s.state !== 'paused' || s.pausedAt !== effect.pausedAt) return 'early';
		// A pause asked for while the book was paused already leaves pausedAt alone, but the engine
		// counts it (handlers.pause) without saying whose it was: the book is theirs to resume now.
		if (s.pauseCount !== effect.pauseCount) return 'paused';
		// Resumed with nobody in the channel, the book would play on to an empty room: the engine
		// parks only on the leave itself, which came while it was paused.
		if (listenerAway(s)) return 'away';
		detach(effect);
		const r = control(effect.books, s, 'resume');
		return r.ok ? 'done' : 'gone';
	}

	function pauseBook(ctx, d, s, ms, line) {
		const r = control(d, s, 'pause');
		if (!r.ok || s.state !== 'paused') return controlRefused(r);
		const effect = track(ctx, { mode: 'book-pause', books: d, sessionId: s.id, pausedAt: s.pausedAt, pauseCount: s.pauseCount, until: now() + ms });
		if (typeof d.onChange === 'function') {
			// notify() runs inside the engine's park, startAt and stop: this only settles the record.
			effect.detach = d.onChange((changed) => {
				if (!changed || changed.id !== effect.sessionId || effect.over) return;
				if (changed.state === 'ended') settle(effect, 'gone');
				else if (changed.state !== 'paused') settle(effect, 'early');
			});
		}
		effect.timer = later(ms, () => {
			effect.timer = null;
			if (effect.over) return;
			settle(effect, liftBookPause(effect));
		});
		return { applied: true, line, until: effect.until, id: effect.id };
	}

	function backBook(ctx, d, s, far, near) {
		let pos = NaN;
		try {
			pos = Number(d.position(s));
		} catch (_) {}
		const r = control(d, s, 'back', BOOK_BACK_MS / 1000);
		if (!r.ok) return controlRefused(r);
		return { applied: true, line: Number.isFinite(pos) && pos < BOOK_BACK_MS ? near : far };
	}

	function restoreKey(userId, workId) {
		return `${userId}\n${workId}`;
	}

	function slowBook(ctx, d, s) {
		const previous = Number(s.speed);
		if (!(previous > SLOW_SPEED)) return pauseBook(ctx, d, s, BREAK_MS, LINE.alreadySlow);
		const r = control(d, s, 'speed', SLOW_SPEED);
		if (!r.ok || s.speed !== SLOW_SPEED) return controlRefused(r);
		const record = { kind: 'speed', userId: ctx.userId, slot: ctx.slot, workId: String(s.workId), previous, until: now() + SLOW_MS };
		const key = armRestore(record);
		track(ctx, { mode: 'speed', books: d, sessionId: s.id, key, until: record.until });
		return { applied: true, line: LINE.slow, until: record.until, restore: { ...record } };
	}

	function applyToBook(ctx) {
		const d = books();
		const s = playingSession(d, ctx.userId);
		if (!s || typeof d.controlSession !== 'function') return refused('absent');
		if (claimed(ctx.where.guildId, ['audiobook'])) return refused('busy');
		switch (ctx.kind) {
			case 'commercial_break':
				return pauseBook(ctx, d, s, BREAK_MS, LINE.bookBreak);
			case 'intermission':
				return pauseBook(ctx, d, s, INTERMISSION_MS, LINE.bookIntermission);
			case 'shuffle_mode':
				return backBook(ctx, d, s, LINE.bookShuffle, LINE.bookShuffleStart);
			case 'rewind':
				return backBook(ctx, d, s, LINE.bookBack, LINE.bookStart);
			default:
				return slowBook(ctx, d, s);
		}
	}

	// --- speed restores -----------------------------------------------------------------------

	function sameWork(a, b) {
		if (a === b) return true;
		try {
			const wa = works().work(a);
			const wb = works().work(b);
			return !!wa && !!wb && wa.id === wb.id;
		} catch (_) {
			return false;
		}
	}

	/** @returns {{outcome: 'restored'|'kept'|'starting'|'missing', speed?: number}} */
	function restoreSpeed(record) {
		const d = books();
		const live = d && typeof d.sessions === 'function'
			? d.sessions().find((s) => s && String(s.userId) === record.userId && s.state !== 'ended' && sameWork(String(s.workId), record.workId))
			: null;
		if (live) {
			if (live.state === 'starting') return { outcome: 'starting' };
			if (live.speed !== SLOW_SPEED) return { outcome: 'kept', speed: live.speed };
			const r = control(d, live, 'speed', record.previous);
			if (r.ok) return { outcome: 'restored', speed: record.previous };
			return { outcome: r.code === 'starting' ? 'starting' : 'missing' };
		}
		let work = null;
		try {
			work = works().work(record.workId);
		} catch (_) {}
		if (!work) return { outcome: 'missing' };
		let mark = null;
		try {
			mark = marks().get(record.userId, work);
		} catch (_) {}
		if (!mark || !Number.isFinite(mark.absoluteMs)) return { outcome: 'missing' };
		if (Number(mark.speed) !== SLOW_SPEED) return { outcome: 'kept', speed: Number(mark.speed) };
		marks().setSpeed(record.userId, work, record.previous);
		return { outcome: 'restored', speed: record.previous };
	}

	function speedLine(result) {
		if (result.outcome === 'restored') return `back to ${result.speed}x`;
		if (result.outcome === 'kept') return `the speed was changed meanwhile, so it stays at ${result.speed}x`;
		return END_LINE.speedNone;
	}

	function armRestore(record) {
		const key = restoreKey(record.userId, record.workId);
		const prior = restores.get(key);
		if (prior) clear(prior.timer);
		const entry = { record, timer: null, tries: 0 };
		restores.set(key, entry);
		entry.timer = later(record.until - now(), () => finishRestore(key, 'done'));
		return key;
	}

	function finishRestore(key, how) {
		const entry = restores.get(key);
		if (!entry) return null;
		clear(entry.timer);
		entry.timer = null;
		let result;
		try {
			result = restoreSpeed(entry.record);
		} catch (err) {
			log().warn('Plex Media: a Slow Motion speed could not be put back:', why(err));
			result = { outcome: 'missing' };
		}
		if (result.outcome === 'starting' && entry.tries < START_RETRIES) {
			entry.tries += 1;
			entry.timer = later(START_RETRY_MS, () => finishRestore(key, how));
			return 'starting';
		}
		restores.delete(key);
		for (const effect of [...running.values()]) {
			if (effect.mode === 'speed' && effect.key === key) running.delete(effect.guildId);
		}
		if (how !== 'quiet') {
			const r = entry.record;
			announceEnd({ userId: r.userId, slot: r.slot ?? null, kind: 'slow_motion', where: 'book', line: speedLine(result), how, speed: true });
		}
		return result.outcome;
	}

	function normaliseRecord(record) {
		const userId = String(record.userId ?? '');
		const workId = String(record.workId ?? '');
		const until = Number(record.until);
		if (!userId || !workId || !Number.isFinite(until)) return null;
		const previous = bookModel.SPEEDS.includes(Number(record.previous)) ? Number(record.previous) : 1;
		return { kind: 'speed', userId, slot: record.slot ?? null, workId, previous, until };
	}

	// --- the API ------------------------------------------------------------------------------

	/**
	 * Run a voice or book trap on this person, now.
	 * @param {string} kind one of VOICE_TRAPS
	 * @param {{userId: string, slot?: *}} who
	 * @returns {Promise<{applied: true, line: string, until?: number, id?: number, restore?: object}|
	 *   {applied: false, reason: 'absent'|'off'|'busy'}>} `until`: when a timed effect ends by itself.
	 *   `id` (a pause or a commercial clip, which stay in force until onEnd says otherwise): a positive
	 *   integer no other effect has, which that onEnd notice carries. `restore` (Slow Motion on a
	 *   book): persist it and hand it to restore() after a restart; its onEnd says `speed: true`.
	 */
	async function apply(kind, { userId, slot } = {}) {
		if (!VOICE_TRAPS.includes(kind)) throw new TypeError(`Not a voice trap: ${kind}`);
		if (!enabled()) return refused('off');
		const uid = String(userId ?? '');
		const where = listening(uid);
		if (!where) return refused('absent');
		if (lockOf(where.guildId)) return refused('busy');
		const ctx = { kind, userId: uid, slot: slot ?? null, where };
		let out;
		try {
			out = where.where === 'book' ? applyToBook(ctx) : await applyToMusic(ctx);
		} catch (err) {
			// The game retries a busy trap every minute for up to 12 h, so one line per cause.
			warnOnce(`apply:${kind}:${why(err)}`, `Plex Media: ${contracts.TRAPS[kind].name} failed on the ${where.where}: ${why(err)}`);
			return refused('busy');
		}
		if (out.applied) log().info(`Plex Media: ${contracts.TRAPS[kind].name} for ${ctx.slot ?? uid} on the ${where.where}: ${out.line}.`);
		return out;
	}

	/**
	 * End this person's running effect at once (Remote Control): lift a trap's pause, take a clip
	 * that has not played off the queue (skip one that is playing), put a Slow Motion speed back.
	 * @returns {Promise<boolean>} whether anything was still in force
	 */
	async function end(userId) {
		const uid = String(userId ?? '');
		let ended = false;
		for (const effect of [...running.values()]) {
			if (effect.userId !== uid || effect.over || effect.mode === 'pending' || effect.mode === 'speed') continue;
			if (!holds(effect)) {
				lapse(effect);
				continue;
			}
			let done = false;
			if (effect.mode === 'music-pause') done = liftMusicPause(effect) === 'done';
			else if (effect.mode === 'book-pause') done = ['done', 'away'].includes(liftBookPause(effect));
			else if (effect.mode === 'clip') done = dropClip(effect, { skipPlaying: true });
			settle(effect, 'quiet');
			ended = ended || done;
		}
		for (const [key, entry] of [...restores]) {
			if (entry.record.userId !== uid) continue;
			const outcome = finishRestore(key, 'quiet');
			ended = ended || outcome === 'restored' || outcome === 'starting';
		}
		return ended;
	}

	/**
	 * After a restart: put a persisted Slow Motion speed back now if it is overdue, or arm it again.
	 * @param {{userId: string, workId: string, previous: number, until: number, slot?: *, kind?: 'speed'}} record
	 *   what apply() returned as `restore`
	 */
	async function restore(record) {
		if (!record || typeof record !== 'object') return;
		if (record.kind !== undefined && record.kind !== 'speed') return;
		const r = normaliseRecord(record);
		if (!r) {
			log().warn('Plex Media: a Slow Motion restore without a user, a work or an end time was skipped.');
			return;
		}
		const key = armRestore(r);
		if (now() >= r.until) finishRestore(key, 'overdue');
	}

	/** Lift the pauses still in force, take queued clips off and drop every timer. */
	function stop() {
		generation += 1;
		for (const effect of [...running.values()]) {
			if (effect.over) continue;
			try {
				if (effect.mode === 'music-pause' && holds(effect)) liftMusicPause(effect);
				else if (effect.mode === 'book-pause' && holds(effect)) liftBookPause(effect);
				else if (effect.mode === 'clip') dropClip(effect, { skipPlaying: false });
			} catch (err) {
				log().warn('Plex Media: a trap could not be undone while stopping:', why(err));
			}
			settle(effect, 'quiet');
		}
		running.clear();
		// Slow Motion comes back through restore() from the game's persisted record.
		for (const entry of restores.values()) clear(entry.timer);
		restores.clear();
	}

	return { listening, apply, end, restore, stop };
}

module.exports = { createTrapRunner, VOICE_TRAPS, CLIP_TITLE, CLIP_ARTIST };
