// helpers/bookEngine.js
//
// The audiobook player. One BookSession per guild, each with its own AudioPlayer and its own
// voice join; music and a book never hold one guild's voice at once (the runPlayback gate,
// bot.musicBusy() and helpers/voiceClaims.js keep them apart).
//
// The engine never reads or writes the music state on the Bot (songQueue apart from its length,
// dispatcher, conn, isPlaying, isPaused, playRun, stopGeneration, stoppedEntry). It calls only
// bot.musicBusy(), bot.openConnection(channel) and, after an explicit /book stop, bot.playSong().
//
// Three rules carry most of the weight:
// - Every seek, chapter and speed change is player.play(newResource), which emits no Idle, so
//   Idle only ever means "this part's stream ended" or "it failed" (section 3.6 of the plan).
// - Pause parks: ffmpeg is killed and only the position is kept, so a paused stream cannot die
//   overnight and come back as an unasked-for retry. The Idle handler acts only while 'playing'.
// - startAt() moves the anchor and drops the resource before its first await, so a save or a
//   stop during a build writes the target, never "the next part plus the old offset".
//
// Card rendering lives in helpers/bookCard.js (deps.card); this file only decides when to post,
// edit or end the card, and hands it a view (see view() for its shape).

const crypto = require('crypto');
const {
	AudioPlayerStatus,
	NoSubscriberBehavior,
	VoiceConnectionStatus,
	createAudioPlayer,
	getVoiceConnection
} = require('@discordjs/voice');
const bookModel = require('./bookModel.js');
const logger = require('./logger.js');

// An AudioPlayer in Buffering has no timeout of its own, and ffmpeg waits forever on an upstream
// that accepted the request and never answers.
const BUFFERING_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 1000;
const RECONNECT_GRACE_MS = 5000;
// Voice's documented reconnect pattern allows 20 s from Signalling or Connecting to Ready; this
// leaves a slow gateway some room beyond it.
const RECONNECT_LIMIT_MS = 30000;
// An admin dragging the bot and the listener following arrive as two updates seconds apart.
const BOT_MOVE_GRACE_MS = 5000;
const CARD_REFRESH_MS = 120000;
const CARD_COALESCE_MS = 1500;
const GATE_EXPLAIN_EVERY_MS = 30000;
// A chapter that ends this close to its part's end is left to Idle, so the two never race.
const CHAPTER_EDGE_MS = 250;
// Fires a little after the chapter end, so position() has passed it on arrival.
const CHAPTER_LATE_PAD_MS = 300;
const DEFAULT_SAVE_SECONDS = 15;
const DEFAULT_IDLE_LEAVE_MINUTES = 10;
// Discord's "Unknown Message" and "Missing Access": the card is gone or unreachable for good.
const UNEDITABLE_CARD = new Set([10008, 50001]);

const STILL_JOINING = 'Still joining the voice channel, one moment.';
const ACTIONS = new Set(['pause', 'resume', 'stop', 'back', 'fwd', 'goto', 'chapter', 'nextch', 'prevch', 'speed', 'sleep']);
const ALIASES = { forward: 'fwd', next: 'nextch', prev: 'prevch', skip: 'nextch' };
// What someone other than the listener may do (plan 3.11).
const OPEN_ACTIONS = new Set(['pause', 'stop']);

function defaultCreatePlayer() {
	// Pause, not Stop: a voice blip auto-pauses and resumes on Ready instead of ending the part.
	// 750 missed frames (15 s) leave room for ffmpeg's -reconnect to resume a dropped request.
	return createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 750 } });
}

function fallbackCard() {
	const line = v => `📚 ${v.title} · ${v.state} · ${bookModel.formatClock(v.positionMs)} / ${bookModel.formatClock(v.totalMs)}`;
	return {
		buildCard: v => ({ content: line(v), embeds: [], components: [], allowedMentions: { parse: [] } }),
		endedCard: v => ({ content: `${line(v)} · ${v.endReason}`, embeds: [], components: [], allowedMentions: { parse: [] } }),
		movedCard: () => ({ content: 'Moved ↓', embeds: [], components: [] })
	};
}

function unref(handle) {
	if (handle && typeof handle.unref === 'function') handle.unref();
	return handle;
}

function result(ok, code, text, extra) {
	return Object.assign({ ok, code, text }, extra || {});
}

function memberId(member) {
	if (!member) return '';
	return String(member.id || (member.user && member.user.id) || '');
}

function displayName(member) {
	if (!member) return 'someone';
	const u = member.user || {};
	return member.displayName || member.nickname || u.globalName || u.username || 'someone';
}

/**
 * @param {object} opts
 * @param {import('discord.js').Client} [opts.client] for voiceStateUpdate; optional in tests
 * @param {object} opts.bot the music Bot: musicBusy(), openConnection(channel), playSong(), songQueue
 * @param {object} [opts.deps] every collaborator, injectable (plan 3.1); all default lazily
 */
function createBookDirector({ client = null, bot = null, deps: given = {} } = {}) {
	const loaded = {};
	const lazy = (name, load) => {
		if (given[name]) return given[name];
		if (!loaded[name]) loaded[name] = load();
		return loaded[name];
	};
	const catalog = () => lazy('catalog', () => require('./bookCatalogStore.js'));
	const bookmarks = () => lazy('bookmarks', () => require('./bookmarks.js'));
	const library = () => lazy('library', () => require('./bookLibrary.js'));
	const proxy = () => lazy('proxy', () => require('./partProxy.js'));
	const voiceClaims = () => lazy('voiceClaims', () => require('./voiceClaims.js'));
	const commandLog = () => lazy('commandLog', () => require('./commandLog.js'));
	const voiceHealth = () => lazy('voiceHealth', () => require('./voiceHealth.js'));
	const createResource = (opts) => (given.createResource || require('./bookResource.js').createBookResource)(opts);
	const createPlayer = () => (given.createPlayer || defaultCreatePlayer)();
	const probe = (key) => (given.probe ? given.probe(key) : proxy().probe(key));
	const urlFor = (key) => (given.urlFor ? given.urlFor(key) : proxy().urlFor(key));
	const repairPartKey = (work, part) => (given.repairPartKey ? given.repairPartKey(work, part) : library().repairPartKey(work, part));
	const ensureFresh = (opts) => (given.ensureFresh ? given.ensureFresh(opts) : library().ensureFresh(opts));
	const voiceConnectionOf = (guildId) => (given.getVoiceConnection || getVoiceConnection)(guildId);
	const timers = given.timers || { setTimeout, clearTimeout, now: Date.now };
	const now = () => timers.now();
	const cfg = () => {
		const c = typeof given.config === 'function' ? given.config() : given.config;
		return c || require('../config/config.js');
	};

	let cardModule = null;
	function card() {
		if (given.card) return given.card;
		if (!cardModule) {
			try {
				cardModule = require('./bookCard.js');
			} catch (err) {
				logger.error('Audiobook card renderer failed to load, using plain text:', err.message || err);
				cardModule = fallbackCard();
			}
		}
		return cardModule;
	}

	const sessions = new Map();
	const gateExplainedAt = new Map();
	let closed = false;

	function event(kind, detail) {
		try { commandLog().recordEvent(kind, detail); } catch (_) {}
	}

	function run(promise) {
		if (promise && typeof promise.catch === 'function') {
			promise.catch(err => logger.error('Audiobook playback error:', (err && err.message) || err));
		}
	}

	function safeKill(kill) {
		if (typeof kill !== 'function') return;
		try { kill(); } catch (_) {}
	}

	// ---- timers ---------------------------------------------------------------------------

	function clearTimer(s, k) {
		if (s.timers[k]) {
			try { timers.clearTimeout(s.timers[k]); } catch (_) {}
			s.timers[k] = null;
		}
	}

	function setTimer(s, k, ms, fn) {
		clearTimer(s, k);
		const handle = unref(timers.setTimeout(() => {
			if (s.timers[k] === handle) s.timers[k] = null;
			try {
				fn();
			} catch (err) {
				logger.error(`Audiobook ${k} timer failed:`, (err && err.message) || err);
			}
		}, Math.max(0, ms)));
		s.timers[k] = handle;
	}

	// ---- position and saving --------------------------------------------------------------

	function totalOf(s) {
		return bookModel.totalMs(s.work);
	}

	function clampWork(s, absMs) {
		const total = totalOf(s);
		if (!Number.isFinite(absMs)) return 0;
		return Math.min(total, Math.max(0, absMs));
	}

	function position(s) {
		if (s.state === 'paused' || s.state === 'ended') return s.parkedAbsMs;
		// 'starting', or a build in flight: the anchor is already the target.
		if (!s.res) return s.anchorAbsMs;
		return Math.min(bookModel.partEndMs(s.work, s.partIndex), s.anchorAbsMs + s.res.playbackDuration * s.resSpeed);
	}

	// playbackDuration is output time, so book time covered is it times the speed it played at.
	function account(s) {
		if (!s.res) return;
		const pd = s.res.playbackDuration;
		const delta = pd - s.lastPdAccounted;
		if (delta > 0) {
			s.pendingListenedMs += delta;
			s.pendingCoveredMs += delta * s.resSpeed;
		}
		s.lastPdAccounted = pd;
	}

	// A rebuild during the session can rename the work (a second edition takes its id, this one
	// keeps the old id as an alias). Saving on under the old id splits the bookmark once anything
	// reads the new id, so the session follows the rename, keeping its own parts so partIndex and
	// the anchor stay valid.
	function followRename(s) {
		let cur = null;
		try { cur = catalog().work(s.workId); } catch (_) {}
		if (!cur || !cur.id || cur.id === s.workId) return;
		s.workId = cur.id;
		s.work = Object.assign({}, s.work, { id: cur.id, aliases: cur.aliases || [] });
		// get() moves a bookmark still under the old id, so record() updates it instead of
		// starting a blank one beside it.
		try { bookmarks().get(s.userId, s.work); } catch (_) {}
	}

	function save(s, { force = false, atMs } = {}) {
		// Nothing was heard while joining; a save would only move lastListenedAt.
		if (s.state === 'starting') return null;
		followRename(s);
		if (s.res) account(s);
		const abs = Number.isFinite(atMs) ? atMs : position(s);
		if (!Number.isFinite(abs)) {
			logger.error(`Audiobook session ${s.id} has no position to save.`);
			return null;
		}
		const fields = {
			absoluteMs: abs,
			speed: s.speed,
			guildId: s.guildId,
			addListenedMs: s.pendingListenedMs,
			addCoveredMs: s.pendingCoveredMs
		};
		if (s.clearFinished) fields.finished = false;
		const r = bookmarks().record(s.userId, s.work, fields, { force });
		// record() always applies the deltas in memory, written or not, so each goes in exactly once.
		s.pendingListenedMs = 0;
		s.pendingCoveredMs = 0;
		s.clearFinished = false;
		if (r && typeof r.healthy === 'boolean') s.saveHealthy = r.healthy;
		return r;
	}

	function armSaveTimer(s) {
		const secs = Number(cfg().audiobookSaveSeconds);
		const ms = (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_SAVE_SECONDS) * 1000;
		setTimer(s, 'save', ms, () => {
			if (s.state === 'playing') save(s);
			if (s.state !== 'ended') armSaveTimer(s);
		});
	}

	// ---- sleep and chapter timers ---------------------------------------------------------

	// Both follow audible time: stashed on park, AutoPaused and every rebuild, re-armed on Playing.
	function stashSleep(s) {
		const sl = s.sleep;
		clearTimer(s, 'sleep');
		if (!sl || sl.mode !== 'timer' || sl.armedAt === null) return;
		sl.remainingMs = Math.max(0, sl.remainingMs - (now() - sl.armedAt));
		sl.armedAt = null;
	}

	function armSleep(s) {
		const sl = s.sleep;
		if (!sl || sl.mode !== 'timer' || sl.armedAt !== null) return;
		sl.armedAt = now();
		setTimer(s, 'sleep', sl.remainingMs, () => stop(s, 'sleep'));
	}

	function sleepRemaining(sl) {
		if (!sl || sl.mode !== 'timer') return null;
		return sl.armedAt === null ? sl.remainingMs : Math.max(0, sl.remainingMs - (now() - sl.armedAt));
	}

	function armChapterTimer(s, fromMs) {
		clearTimer(s, 'chapter');
		if (s.state !== 'playing' || !s.res) return;
		const pos = position(s);
		const ch = bookModel.chapterAt(s.work, Math.max(pos, Number.isFinite(fromMs) ? fromMs : pos));
		if (!ch || !ch.embedded) return;
		if (ch.endMs >= bookModel.partEndMs(s.work, ch.partIndex) - CHAPTER_EDGE_MS) return;
		const delay = Math.max(0, ch.endMs - pos) / s.resSpeed + CHAPTER_LATE_PAD_MS;
		setTimer(s, 'chapter', delay, () => onChapterEnd(s, ch.endMs));
	}

	function onChapterEnd(s, chapterEnd) {
		if (s.state !== 'playing' || !s.res) return;
		const pos = position(s);
		// A blip or a slow start: the audio has not got there yet.
		if (chapterEnd - pos > CHAPTER_EDGE_MS) {
			setTimer(s, 'chapter', (chapterEnd - pos) / s.resSpeed + CHAPTER_LATE_PAD_MS, () => onChapterEnd(s, chapterEnd));
			return;
		}
		if (s.sleep && s.sleep.mode === 'chapter') {
			stop(s, 'sleep', { atMs: chapterEnd });
			return;
		}
		requestCardEdit(s);
		armChapterTimer(s, chapterEnd);
	}

	function armIdleLeave(s) {
		const mins = Number(cfg().audiobookIdleLeaveMinutes);
		const ms = (Number.isFinite(mins) && mins > 0 ? mins : DEFAULT_IDLE_LEAVE_MINUTES) * 60000;
		s.leaveAt = now() + ms;
		setTimer(s, 'idleLeave', ms, () => stop(s, 'idle'));
	}

	// ---- building resources ---------------------------------------------------------------

	// Only a session that is still the guild's session and still meant to be audible may build.
	// A retry or watchdog timer can fire after a park or a stop; this is what stops it playing.
	function live(s) {
		return s.state === 'playing' && sessions.get(s.guildId) === s;
	}

	// A failed build leaves the previous resource playing at a stale spot; nothing may be heard
	// that the session no longer accounts for.
	function silenceStray(s) {
		const p = s.player;
		if (!p || p.state.status === AudioPlayerStatus.Idle || p.state.resource === s.res) return;
		try { p.stop(true); } catch (_) {}
	}

	async function startAt(s, absMs) {
		clearTimer(s, 'retry');
		clearTimer(s, 'buffering');
		if (!live(s)) return;
		const gen = ++s.resGen;
		const stale = () => gen !== s.resGen || !live(s);
		if (s.res) account(s);
		stashSleep(s);
		s.audible = false;
		const { partIndex, partMs } = bookModel.locate(s.work, clampWork(s, absMs));
		s.partIndex = partIndex;
		s.anchorAbsMs = bookModel.partStartMs(s.work, partIndex) + partMs;
		s.res = null;
		s.kill = null;
		clearTimer(s, 'chapter');
		save(s, { force: true });
		const part = s.work.parts[partIndex];
		// By identity, never by ordinal: a rebuild during the session can insert or reorder parts.
		let key = null;
		try { key = catalog().partKeyFor(s.workId, part); } catch (_) {}
		key = key || part.partKey;
		let probed;
		try {
			probed = await probe(key);
		} catch (err) {
			probed = { ok: false, status: 'error' };
		}
		if (stale()) return;
		if (!probed) probed = { ok: false, status: 'error' };
		if (!probed.ok && probed.status === 404) {
			try {
				key = await repairPartKey(s.work, part);
			} catch (err) {
				key = null;
			}
			if (stale()) return;
			if (!key) {
				silenceStray(s);
				fileMissing(s);
				return;
			}
		} else if (!probed.ok) {
			silenceStray(s);
			earlyEnd(s, `probe-${probed.status}`);
			return;
		}
		let built;
		try {
			// urlFor throws before the proxy has started; probe() above starts it.
			built = createResource({ url: urlFor(key), startMs: partMs, speed: s.speed });
		} catch (err) {
			logger.error(`Audiobook part ${partIndex + 1} of ${s.workId} could not start:`, (err && err.message) || err);
			silenceStray(s);
			earlyEnd(s, 'build-failed');
			return;
		}
		if (stale()) {
			safeKill(built.kill);
			return;
		}
		s.res = built.resource;
		s.kill = built.kill;
		s.resSpeed = s.speed;
		s.lastPdAccounted = 0;
		s.lastAudioAt = now();
		try {
			s.player.play(s.res);
		} catch (err) {
			logger.error('Audiobook player refused a resource:', (err && err.message) || err);
			s.res = null;
			s.kill = null;
			safeKill(built.kill);
			silenceStray(s);
			earlyEnd(s, 'play-failed');
			return;
		}
		armBufferingWatchdog(s, gen, built);
	}

	function armBufferingWatchdog(s, gen, built) {
		setTimer(s, 'buffering', BUFFERING_TIMEOUT_MS, () => {
			if (gen !== s.resGen || !live(s)) return;
			const st = s.player.state;
			if (st.status !== AudioPlayerStatus.Buffering || st.resource !== s.res) return;
			// Dropped first, so the Idle from the stop below fails the identity guard.
			s.res = null;
			s.kill = null;
			s.resGen++;
			safeKill(built.kill);
			try { s.player.stop(true); } catch (_) {}
			earlyEnd(s, 'buffering-timeout');
		});
	}

	// ---- the end of a part ----------------------------------------------------------------

	function lastPlayableIndex(s) {
		return bookModel.locate(s.work, totalOf(s)).partIndex;
	}

	function partEnded(s, { eos, outputMs, endAbs, early = false }) {
		const verdict = bookModel.classifyPartEnd({
			eos,
			startAbs: s.anchorAbsMs,
			endAbs,
			partEndAbs: bookModel.partEndMs(s.work, s.partIndex),
			outputMs,
			lastAttempt: s.lastAttempt,
			partDurationMs: s.work.parts[s.partIndex] ? s.work.parts[s.partIndex].durationMs : 0,
			isLastPart: s.partIndex >= lastPlayableIndex(s),
			sleepAtChapterEnd: !!(s.sleep && s.sleep.mode === 'chapter'),
			recentFailures: s.failures,
			now: now()
		});
		// classifyPartEnd is pure: the 3-in-2-min rule only works if its list is kept.
		s.failures = verdict.failures;
		s.lastAttempt = { startAbs: s.anchorAbsMs, outputMs, eos };
		if (!early && (verdict.action === 'retry' || verdict.action === 'park-failing')) {
			voiceHealth().event('book-early-end', { reason: verdict.reason, outputMs, workId: s.workId, part: s.partIndex + 1 });
		}
		act(s, verdict, endAbs);
	}

	// A part end that never reached the player: probe failure or timeout, Buffering watchdog.
	function earlyEnd(s, reason) {
		if (!live(s)) return;
		s.lastEndReason = reason;
		voiceHealth().event('book-early-end', { reason, workId: s.workId, part: s.partIndex + 1 });
		partEnded(s, { eos: false, outputMs: 0, endAbs: s.anchorAbsMs, early: true });
	}

	function act(s, verdict, endAbs) {
		const partEnd = bookModel.partEndMs(s.work, s.partIndex);
		switch (verdict.action) {
			case 'next-part':
				run(startAt(s, partEnd));
				requestCardEdit(s);
				break;
			case 'finish-work':
				finishSession(s);
				break;
			case 'sleep-stop':
				stop(s, 'sleep', { atMs: partEnd });
				break;
			case 'retry':
				// position() reads the anchor while there is no resource; left at the failed
				// attempt's start, a pause or a relative jump in the gap would go back by all of it.
				s.anchorAbsMs = endAbs;
				setTimer(s, 'retry', RETRY_DELAY_MS, () => run(startAt(s, endAbs)));
				break;
			case 'park-failing': {
				const fileEndsEarly = verdict.reason === 'file-ends-early';
				const partClock = bookModel.formatClock(endAbs - bookModel.partStartMs(s.work, s.partIndex));
				const detail = fileEndsEarly
					? `The file for ${partLabel(s, s.partIndex)} ends early at ${partClock}. Your place is saved.`
					: `Plex stopped sending audio 3 times in 2 minutes. Paused at ${clockOf(s, endAbs)}.`;
				park(s, fileEndsEarly ? 'file-ends-early' : 'plex-failing', { atMs: endAbs, detail });
				break;
			}
			default:
				logger.error(`Audiobook part end gave an unknown action: ${verdict.action}`);
		}
	}

	function fileMissing(s) {
		const ch = bookModel.chapterAt(s.work, s.anchorAbsMs);
		const where = ch ? `Ch ${ch.number}` : partLabel(s, s.partIndex);
		s.endDetail = `Plex can't find the file for ${where} (it may have moved). Your place is saved; try again in a minute.`;
		stop(s, 'failed-file');
	}

	// A natural end of the last part. The deltas go in with a save at the very end, then
	// markFinished, and stop() saves nothing after it: a smaller position would overwrite the
	// end-of-work hint that resumeStart reads.
	function finishSession(s) {
		const total = totalOf(s);
		try {
			save(s, { force: true, atMs: total });
			bookmarks().markFinished(s.userId, s.work, { guildId: s.guildId });
		} catch (err) {
			logger.error('Audiobook could not mark a work finished:', (err && err.message) || err);
		}
		stop(s, 'finished', { atMs: total });
	}

	// ---- park, resume, stop ---------------------------------------------------------------

	function park(s, reason, { atMs, detail } = {}) {
		if (s.state !== 'playing') return false;
		const abs = Number.isFinite(atMs) ? atMs : position(s);
		if (s.res) account(s);
		const kill = s.kill;
		s.state = 'paused';
		s.parkedAbsMs = clampWork(s, abs);
		s.resGen++;
		s.res = null;
		s.kill = null;
		for (const k of ['retry', 'buffering', 'chapter', 'botMoved']) clearTimer(s, k);
		stashSleep(s);
		s.audible = false;
		// Idle is synchronous here and ignored by the guard. The stream's 'close' would kill
		// ffmpeg a tick later; killing now means a park never leaves a process behind.
		if (s.player) {
			try { s.player.stop(true); } catch (_) {}
		}
		safeKill(kill);
		s.pauseReason = reason;
		s.pauseDetail = detail || null;
		s.pausedAt = now();
		save(s, { force: true });
		armIdleLeave(s);
		requestCardEdit(s);
		return true;
	}

	function ensureSubscribed(s) {
		const c = s.conn;
		if (!c || !c.state || c.state.status === VoiceConnectionStatus.Destroyed) return;
		const sub = c.state.subscription;
		if (!sub || sub.player !== s.player) {
			try { c.subscribe(s.player); } catch (_) {}
		}
	}

	function resume(s) {
		const gap = now() - (s.pausedAt || now());
		const rewindMs = Math.min(s.parkedAbsMs, bookModel.resumeRewindMs(gap, cfg().audiobookResumeRewindSeconds));
		const abs = Math.max(0, s.parkedAbsMs - rewindMs);
		s.state = 'playing';
		clearTimer(s, 'idleLeave');
		s.pausedAt = null;
		s.leaveAt = null;
		s.pauseReason = null;
		s.pauseDetail = null;
		ensureSubscribed(s);
		run(startAt(s, abs));
		return { rewindMs, abs };
	}

	/**
	 * End a session. Safe in any state and twice. Saves (except while 'starting', for 'finished'
	 * and for 'forgotten'), releases the claim in a finally, edits the card to its ended form and,
	 * for an explicit stop only, starts the music that queued behind the book (decision D1).
	 */
	function stop(s, reason, { atMs, by = null, quietCard = false } = {}) {
		if (!s || s.state === 'ended') return null;
		const wasStarting = s.state === 'starting';
		const noSave = wasStarting || reason === 'finished' || reason === 'forgotten';
		try {
			if (!wasStarting) {
				const abs = Number.isFinite(atMs) ? atMs : position(s);
				if (s.res) account(s);
				s.parkedAbsMs = clampWork(s, abs);
			}
			s.state = 'ended';
			s.resGen++;
			s.endReason = reason;
			s.stoppedBy = by;
			s.endedAt = now();
			if (!noSave) save(s, { force: true });
		} catch (err) {
			logger.error('Audiobook stop could not save:', (err && err.message) || err);
		} finally {
			s.state = 'ended';
			for (const k of Object.keys(s.timers)) clearTimer(s, k);
			s.audible = false;
			if (s.player) {
				s.player.removeAllListeners();
				try { s.player.stop(true); } catch (_) {}
			}
			safeKill(s.kill);
			s.res = null;
			s.kill = null;
			if (s.conn) {
				if (s.onConnState) s.conn.removeListener('stateChange', s.onConnState);
				try {
					if (s.conn.state.status !== VoiceConnectionStatus.Destroyed) s.conn.destroy();
				} catch (_) {}
			}
			if (sessions.get(s.guildId) === s) sessions.delete(s.guildId);
		}
		logger.info(`Audiobook session ${s.id} ended (${reason}) at ${bookModel.formatClock(s.parkedAbsMs)} in ${s.workId}.`);
		if (!quietCard) endCard(s);
		maybeStartQueuedMusic(s, reason);
		return s.parkedAbsMs;
	}

	// D1: only an explicit /book stop or the card's Stop hands the voice back to queued music.
	// The replay is a plain channel-shaped message: an interaction adapter's token may have
	// expired, and runPlayback needs a member in voice because the book's connection is gone.
	function maybeStartQueuedMusic(s, reason) {
		if (reason !== 'explicit' || !s.lastGate || !bot) return;
		if (!Array.isArray(bot.songQueue) || bot.songQueue.length === 0) return;
		if (typeof bot.musicBusy === 'function' && bot.musicBusy()) return;
		try {
			const p = bot.playSong(gateReplay(s));
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (err) {
			logger.error('Audiobook could not start the queued music:', (err && err.message) || err);
		}
	}

	function gateReplay(s) {
		const g = s.lastGate;
		const inVoiceHere = m => !!(m && m.voice && m.voice.channel && m.voice.channel.guild && m.voice.channel.guild.id === s.guildId);
		const member = inVoiceHere(g.member) ? g.member : (s.stoppedBy || g.member);
		const channel = g.textChannel || s.textChannel;
		return {
			guild: s.guild,
			member,
			author: (member && member.user) || { id: g.requesterId },
			channel,
			reply: p => channel.send(p),
			content: ''
		};
	}

	// ---- card -----------------------------------------------------------------------------

	function enqueueCard(s, op) {
		s.cardChain = s.cardChain.then(op).catch((err) => {
			if (err && UNEDITABLE_CARD.has(err.code)) {
				s.card = null;
				return;
			}
			logger.warn('Audiobook card update failed:', (err && err.message) || err);
		});
		return s.cardChain;
	}

	function editCard(s) {
		if (s.state === 'starting' || s.state === 'ended') return;
		clearTimer(s, 'cardEdit');
		s.cardEditAt = now();
		enqueueCard(s, async () => {
			if (s.state === 'ended') return;
			const payload = card().buildCard(view(s));
			if (!s.card) {
				if (!s.textChannel) return;
				s.card = await s.textChannel.send(payload);
				return;
			}
			await s.card.edit(payload);
		});
	}

	// At most one edit per 1.5 s, with a trailing edit so the last change always shows.
	function requestCardEdit(s) {
		if (s.state === 'starting' || s.state === 'ended') return;
		if (s.timers.cardEdit) return;
		const wait = s.cardEditAt + CARD_COALESCE_MS - now();
		if (wait <= 0) {
			editCard(s);
			return;
		}
		setTimer(s, 'cardEdit', wait, () => editCard(s));
	}

	function armCardRefresh(s) {
		setTimer(s, 'card', CARD_REFRESH_MS, () => {
			if (s.state === 'playing') requestCardEdit(s);
			if (s.state !== 'ended') armCardRefresh(s);
		});
	}

	function endCard(s) {
		enqueueCard(s, async () => {
			const payload = card().endedCard(view(s));
			if (s.card) {
				await s.card.edit(payload);
				return;
			}
			// A session that never got past the join has no card; the command reply covers it.
			if (!s.everPlayed || s.endReason === 'shutdown' || !s.textChannel) return;
			s.card = await s.textChannel.send(payload);
		});
	}

	/** The engine's state for a card edited elsewhere (a button's interaction.update). */
	function noteCardUpdated(s) {
		if (!s) return;
		clearTimer(s, 'cardEdit');
		s.cardEditAt = now();
	}

	// ---- view -----------------------------------------------------------------------------

	function partLabel(s, i) {
		const p = s.work.parts[i];
		return (p && p.title) || `Part ${(p && p.ordinal) || i + 1}`;
	}

	function clockOf(s, ms) {
		return bookModel.formatClock(ms, totalOf(s) >= 3600000);
	}

	/**
	 * Everything the card needs, as plain data. Times named `...At` are epoch ms (for <t:…:R>),
	 * positions are ms from the start of the work.
	 */
	function view(s) {
		const work = s.work;
		const total = totalOf(s);
		const pos = position(s);
		const chs = bookModel.chapters(work);
		const ch = bookModel.chapterAt(work, pos);
		const t = now();
		const audible = s.state === 'playing' && s.audible;
		const remaining = Math.max(0, total - pos);
		let sleep = null;
		if (s.sleep && s.sleep.mode === 'chapter') sleep = { mode: 'chapter' };
		else if (s.sleep && s.sleep.mode === 'timer') {
			const left = sleepRemaining(s.sleep);
			sleep = { mode: 'timer', minutes: s.sleep.minutes, remainingMs: left, endsAt: s.sleep.armedAt !== null ? t + left : null };
		}
		let finished = null;
		if (s.endReason === 'finished') {
			let mark = null;
			try { mark = bookmarks().get(s.userId, work); } catch (_) {}
			const startedAt = mark && Number.isFinite(mark.startedAt) ? mark.startedAt : null;
			const finishedAt = mark && Number.isFinite(mark.finishedAt) ? mark.finishedAt : t;
			finished = {
				totalMs: total,
				startedAt,
				finishedAt,
				days: startedAt === null ? null : Math.max(1, Math.ceil((finishedAt - startedAt) / 86400000))
			};
		}
		let saveHealthy = s.saveHealthy;
		try { saveHealthy = bookmarks().healthy(); } catch (_) {}
		return {
			sessionId: s.id,
			guildId: s.guildId,
			userId: s.userId,
			workId: s.workId,
			listener: { id: s.userId, name: s.listenerName, mention: `<@${s.userId}>` },
			title: work.title || work.id,
			author: work.author || null,
			series: work.series || null,
			sequence: work.sequence === undefined ? null : work.sequence,
			narrator: work.narrator || null,
			edition: work.edition || null,
			kind: work.kind || 'book',
			state: s.state,
			buffering: s.state === 'playing' && !s.audible,
			positionMs: pos,
			totalMs: total,
			fraction: total > 0 ? Math.min(1, pos / total) : 0,
			remainingMs: remaining,
			remainingAtSpeedMs: remaining / s.speed,
			chapter: ch ? {
				index: ch.number,
				count: chs.length,
				title: ch.title,
				startMs: ch.startMs,
				endMs: ch.endMs,
				endsAt: audible ? t + Math.max(0, ch.endMs - pos) / s.speed : null
			} : null,
			partIndex: s.partIndex,
			partCount: work.parts.length,
			speed: s.speed,
			sleep,
			paused: s.state === 'paused' ? { at: s.pausedAt, leaveAt: s.leaveAt, reason: s.pauseReason, detail: s.pauseDetail } : null,
			queuedMusicCount: bot && Array.isArray(bot.songQueue) ? bot.songQueue.length : 0,
			voiceChannel: { id: s.voiceChannelId, name: s.voiceChannelName },
			saveHealthy,
			nearEnd: bookModel.nearEnd(work, pos),
			endReason: s.endReason,
			endDetail: s.endDetail,
			finished
		};
	}

	// ---- voice ----------------------------------------------------------------------------

	function wirePlayer(s, player) {
		player.on(AudioPlayerStatus.Idle, (oldState) => {
			if (s.state !== 'playing' || !oldState || !oldState.resource || oldState.resource !== s.res) return;
			try {
				const r = oldState.resource;
				account(s);
				const outputMs = r.playbackDuration;
				const endAbs = Math.min(bookModel.partEndMs(s.work, s.partIndex), s.anchorAbsMs + outputMs * s.resSpeed);
				// Not resource.ended: silence padding makes it true after any unforced stop.
				const eos = !!(r.playStream && r.playStream.readableEnded);
				s.res = null;
				s.kill = null;
				s.audible = false;
				stashSleep(s);
				clearTimer(s, 'chapter');
				clearTimer(s, 'buffering');
				partEnded(s, { eos, outputMs, endAbs });
			} catch (err) {
				logger.error('Audiobook part end handling failed:', (err && err.message) || err);
			}
		});
		player.on(AudioPlayerStatus.Playing, (oldState, newState) => {
			if (s.state !== 'playing' || !newState || newState.resource !== s.res) return;
			clearTimer(s, 'buffering');
			s.audible = true;
			s.lastAudioAt = now();
			armChapterTimer(s);
			armSleep(s);
		});
		player.on(AudioPlayerStatus.AutoPaused, (oldState, newState) => {
			if (!newState || newState.resource !== s.res) return;
			s.audible = false;
			stashSleep(s);
			clearTimer(s, 'chapter');
		});
		// AudioPlayer 'error' is always followed by Idle for the same resource; only Idle acts.
		player.on('error', (err) => {
			try {
				logger.error(`Audiobook stream error in ${s.workId}:`, (err && err.message) || err);
				event('book-stream-error', { workId: s.workId, part: s.partIndex + 1, error: (err && err.message) || String(err) });
			} catch (_) {}
		});
		player.on('unsubscribe', () => {
			if (s.state !== 'playing') return;
			// A destroyed connection unsubscribes first; its own stateChange ends the session.
			if (!s.conn || !s.conn.state || s.conn.state.status === VoiceConnectionStatus.Destroyed) return;
			park(s, 'unsubscribed');
		});
	}

	function onConnState(s, oldState, newState) {
		if (sessions.get(s.guildId) !== s || s.state === 'ended' || s.state === 'starting') return;
		const st = newState && newState.status;
		if (st === VoiceConnectionStatus.Destroyed) {
			stop(s, 'voice-lost');
			return;
		}
		if (st === VoiceConnectionStatus.Ready) {
			clearTimer(s, 'reconnect');
			s.reconnectKind = null;
			s.reconnectSince = null;
			return;
		}
		// An AutoPaused player on a connection that never comes back hangs forever, holding the
		// gate. A move between channels or a resumable drop leaves Disconnected within seconds; a
		// rejoin the gateway never answers sits in Signalling or Connecting with no timeout of
		// voice's own. Each kind is bounded once: a stateChange that keeps the status, or
		// Signalling moving on to Connecting, does not extend it. A connection flapping between
		// kinds would re-arm forever, so the whole time away from Ready is capped as well.
		const kind = st === VoiceConnectionStatus.Disconnected ? 'disconnected' : 'reconnecting';
		if (s.timers.reconnect && s.reconnectKind === kind) return;
		if (s.reconnectSince == null) s.reconnectSince = now();
		s.reconnectKind = kind;
		const kindMs = kind === 'disconnected' ? RECONNECT_GRACE_MS : RECONNECT_LIMIT_MS;
		const leftMs = s.reconnectSince + RECONNECT_LIMIT_MS - now();
		setTimer(s, 'reconnect', Math.min(kindMs, leftMs), () => stop(s, 'voice-lost'));
	}

	function onVoiceState(oldState, newState) {
		try {
			const guild = (newState && newState.guild) || (oldState && oldState.guild);
			const s = guild ? sessions.get(guild.id) : null;
			if (!s || s.state === 'starting' || s.state === 'ended') return;
			const id = (newState && newState.id) || (oldState && oldState.id);
			const botId = client && client.user && client.user.id;
			const before = oldState ? oldState.channelId : null;
			const after = newState ? newState.channelId : null;
			if (botId && id === botId) {
				if (after && after !== s.voiceChannelId) {
					s.voiceChannelId = after;
					s.voiceChannelName = (newState.channel && newState.channel.name) || s.voiceChannelName;
					// Moved away from the listener: their leave from this channel can never come.
					if (listenerInChannel(s)) clearTimer(s, 'botMoved');
					else if (s.state === 'playing') {
						setTimer(s, 'botMoved', BOT_MOVE_GRACE_MS, () => {
							if (s.state === 'playing' && !listenerInChannel(s)) park(s, 'listener-left');
						});
					}
				}
				return;
			}
			if (id !== s.userId) return;
			if (after === s.voiceChannelId) clearTimer(s, 'botMoved');
			// Rejoining does not resume: the card shows Resume.
			if (before === s.voiceChannelId && after !== s.voiceChannelId) park(s, 'listener-left');
		} catch (err) {
			logger.error('Audiobook voice state handling failed:', (err && err.message) || err);
		}
	}

	if (client && typeof client.on === 'function') client.on('voiceStateUpdate', onVoiceState);

	try {
		voiceClaims().register('audiobook', (guildId) => {
			const s = sessions.get(guildId);
			// Hitster prints this verbatim: a plain name, never a mention. 'starting' claims too.
			return s && s.state !== 'ended' ? (s.listenerName || 'someone') : null;
		});
	} catch (err) {
		logger.error('Audiobook voice claim failed to register:', (err && err.message) || err);
	}

	// ---- permissions ----------------------------------------------------------------------

	function listenerInChannel(s) {
		const cache = s.guild && s.guild.voiceStates && s.guild.voiceStates.cache;
		const vs = cache && typeof cache.get === 'function' ? cache.get(s.userId) : null;
		return !!vs && vs.channelId === s.voiceChannelId;
	}

	function normalise(s, action) {
		const a = ALIASES[action] || action;
		if (a === 'toggle') return s && s.state === 'paused' ? 'resume' : 'pause';
		return a;
	}

	/**
	 * Plan 3.11: the listener does everything; the bot owner, and anyone in the book's channel
	 * while the listener is not in it, may pause and stop.
	 */
	function canControl(s, member, action) {
		if (!s || !member) return false;
		const id = memberId(member);
		if (id && id === s.userId) return true;
		if (!OPEN_ACTIONS.has(normalise(s, action))) return false;
		const owner = cfg().ownerId;
		if (owner && id === String(owner)) return true;
		const voice = member.voice;
		const inBookChannel = !!voice && (voice.channelId || (voice.channel && voice.channel.id)) === s.voiceChannelId;
		return inBookChannel && !listenerInChannel(s);
	}

	// ---- controls -------------------------------------------------------------------------

	function where(s, ms) {
		const ch = bookModel.chapterAt(s.work, ms);
		const chs = bookModel.chapters(s.work);
		return ch ? `${clockOf(s, ms)} (Ch ${ch.number} of ${chs.length})` : clockOf(s, ms);
	}

	function jump(s, target, prefix) {
		const at = bookModel.clampTarget(s.work, target);
		if (s.state === 'playing') {
			run(startAt(s, at));
		} else {
			// Parked: move the place, spawn nothing.
			s.parkedAbsMs = at;
			save(s, { force: true });
		}
		return result(true, 'ok', `${prefix} ${where(s, at)}`);
	}

	function secondsArg(arg) {
		if (arg === undefined || arg === null || arg === '') return 30000;
		if (typeof arg === 'number') return Number.isFinite(arg) && arg > 0 ? arg * 1000 : null;
		const ms = bookModel.parseDuration(String(arg));
		return ms && ms > 0 ? ms : null;
	}

	function setSpeed(s, arg) {
		const x = arg === undefined || arg === null || arg === 'cycle' ? bookModel.nextSpeed(s.speed) : Number(arg);
		if (!bookModel.SPEEDS.includes(x)) {
			return result(false, 'bad-arg', `Speed must be one of ${bookModel.SPEEDS.map(v => v + 'x').join(', ')}.`);
		}
		if (s.state === 'playing') {
			const abs = position(s);
			s.speed = x;
			run(startAt(s, abs));
		} else {
			s.speed = x;
			save(s, { force: true });
		}
		return result(true, 'ok', `⚡ ${x}x`);
	}

	function setSleep(s, arg) {
		let v = arg === undefined || arg === null || arg === 'cycle' ? bookModel.nextSleep(s.sleep) : arg;
		if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v);
		stashSleep(s);
		if (v === 'off' || v === 0) {
			s.sleep = null;
			return result(true, 'ok', '🌙 Sleep timer off.');
		}
		if (v === 'chapter') {
			s.sleep = { mode: 'chapter' };
			return result(true, 'ok', '🌙 I\'ll stop at the end of this chapter.');
		}
		if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 24 * 60) {
			return result(false, 'bad-arg', 'Sleep takes a number of minutes, `chapter` or `off`.');
		}
		s.sleep = { mode: 'timer', minutes: v, remainingMs: v * 60000, armedAt: null };
		if (s.audible) armSleep(s);
		const when = s.audible ? `<t:${Math.round((now() + v * 60000) / 1000)}:R>` : `after ${v} min of listening`;
		return result(true, 'ok', `🌙 Sleep ${when}.`);
	}

	const handlers = {
		pause(s) {
			if (s.state === 'paused') return result(true, 'noop', 'Already paused.');
			const abs = position(s);
			park(s, 'paused');
			return result(true, 'ok', `⏸ Paused at ${where(s, abs)}.`);
		},
		resume(s) {
			if (s.state === 'playing') return result(true, 'noop', 'Already playing.');
			const { rewindMs, abs } = resume(s);
			const rewound = rewindMs > 0 ? `, rewound ${Math.round(rewindMs / 1000)} s` : '';
			return result(true, 'ok', `▶ Resuming at ${where(s, abs)}${rewound}.`);
		},
		stop(s, arg, member, opts) {
			const at = stop(s, opts.reason || 'explicit', { by: member, quietCard: !!opts.cardUpdated });
			return result(true, 'ok', `⏹ Stopped. Saved at ${where(s, at)}.`);
		},
		back(s, arg) {
			const ms = secondsArg(arg);
			if (ms === null) return result(false, 'bad-arg', 'Back by how much? Try 30, 1:30 or 2m.');
			return jump(s, position(s) - ms, '⏪');
		},
		fwd(s, arg) {
			const ms = secondsArg(arg);
			if (ms === null) return result(false, 'bad-arg', 'Forward by how much? Try 30, 1:30 or 2m.');
			return jump(s, position(s) + ms, '⏩');
		},
		goto(s, arg) {
			const g = arg && typeof arg === 'object' ? arg : bookModel.parseGoto(arg);
			if (!g || !Number.isFinite(g.ms)) return result(false, 'bad-arg', 'Go to where? Try 1:23:45, +5m or -90.');
			return jump(s, g.mode === 'relative' ? position(s) + g.ms : g.ms, '↪');
		},
		chapter(s, arg) {
			const chs = bookModel.chapters(s.work);
			const n = Number(arg);
			const ch = Number.isInteger(n) ? chs[n - 1] : null;
			if (!ch) return result(false, 'bad-arg', `There is no chapter ${arg}; this one has 1 to ${chs.length}.`);
			return jump(s, ch.startMs, `📖 ${ch.title} ·`);
		},
		nextch(s) {
			const ch = bookModel.nextChapter(s.work, position(s));
			// Skipping past the last chapter never finishes a work.
			if (!ch) return result(true, 'noop', 'This is the last chapter.');
			return jump(s, ch.startMs, `⏭ ${ch.title} ·`);
		},
		prevch(s) {
			const ch = bookModel.prevChapter(s.work, position(s));
			if (!ch) return result(true, 'noop', 'No chapters here.');
			return jump(s, ch.startMs, `⏮ ${ch.title} ·`);
		},
		speed(s, arg) {
			return setSpeed(s, arg);
		},
		sleep(s, arg) {
			return setSleep(s, arg);
		}
	};

	/**
	 * Act on a live session. Synchronous: a resource build starts and is not awaited.
	 * @param {object} s a session from session() or sessionById()
	 * @param {object} member the GuildMember acting
	 * @param {string} action pause, resume, toggle, stop, back, fwd (forward), goto, chapter,
	 *   nextch (next, skip), prevch (prev), speed, sleep
	 * @param {*} [arg] seconds or a duration string for back/fwd (default 30 s); a parseGoto string
	 *   or { mode, ms } for goto; a 1-based number for chapter; a speed (or 'cycle'/undefined for the
	 *   card's next step) for speed; minutes, 'chapter', 'off' (or 'cycle'/undefined) for sleep
	 * @param {object} [opts]
	 * @param {string} [opts.reason] stop reason, default 'explicit'; 'generic' for a delegated !stop
	 * @param {boolean} [opts.cardUpdated] the caller edits the card itself (interaction.update), so
	 *   the engine skips its own edit for this action, the ended-card edit included
	 * @returns {{ ok, code, text, view, sessionId }} code: ok, noop, forbidden, starting, bad-arg,
	 *   bad-action, no-session
	 */
	function controlSession(s, member, action, arg, opts = {}) {
		if (!s || s.state === 'ended' || sessions.get(s.guildId) !== s) {
			return result(false, 'no-session', 'That book is no longer playing.');
		}
		const a = normalise(s, action);
		if (!ACTIONS.has(a)) return result(false, 'bad-action', `Unknown book control: ${action}.`);
		if (!canControl(s, member, a)) {
			return result(false, 'forbidden', `This is ${s.listenerName}'s book: only they can control it. Stop is open to everyone once they've left the channel.`, { sessionId: s.id });
		}
		// player and conn do not exist yet.
		if (s.state === 'starting' && a !== 'stop') return result(false, 'starting', STILL_JOINING, { sessionId: s.id });
		let out;
		try {
			out = handlers[a](s, arg, member, opts);
		} catch (err) {
			logger.error(`Audiobook ${a} failed:`, (err && err.message) || err);
			out = result(false, 'error', 'That did not work; the card shows where the book is.');
		}
		if (opts.cardUpdated) noteCardUpdated(s);
		else if (a !== 'stop') requestCardEdit(s);
		return Object.assign(out, { view: view(s), sessionId: s.id });
	}

	function control(guildId, member, action, arg, opts = {}) {
		const s = sessions.get(guildId);
		if (!s) return result(false, 'no-session', 'No book is playing in this server.');
		return controlSession(s, member, action, arg, opts);
	}

	// ---- play -----------------------------------------------------------------------------

	function norm(text) {
		try {
			return require('./bookCatalog.js').norm(text);
		} catch (_) {
			return String(text || '').toLowerCase().trim();
		}
	}

	function percentFor(userId, work) {
		try {
			const mark = bookmarks().get(userId, work);
			const total = bookModel.totalMs(work);
			return mark && total > 0 ? Math.round((mark.absoluteMs / total) * 100) : null;
		} catch (_) {
			return null;
		}
	}

	// findWorks ranks but does not say by how much, so a clear winner is found by title tiers:
	// one exact title, then one title prefix, then one title whose words all the tokens prefix.
	function pickWork(hits, query) {
		if (hits.length === 1) return { work: hits[0] };
		const q = norm(query);
		const tokens = q.split(' ').filter(Boolean);
		const tiers = [
			w => norm(w.title) === q,
			w => norm(w.title).startsWith(q),
			w => { const words = norm(w.title).split(' '); return tokens.every(t => words.some(x => x.startsWith(t))); }
		];
		for (const match of tiers) {
			const inTier = hits.filter(match);
			if (inTier.length === 1) return { work: inTier[0] };
			if (inTier.length > 1) return { choices: inTier };
		}
		return { choices: hits };
	}

	function resolveWork(ctx, userId) {
		if (ctx.work && typeof ctx.work === 'object') return { work: catalog().work(ctx.work.id) || ctx.work };
		if (ctx.workId) {
			const w = catalog().work(String(ctx.workId));
			return w ? { work: w } : { error: result(false, 'not-found', 'That book is not in the library any more.') };
		}
		const q = String(ctx.query || '').trim();
		if (!q) {
			const mark = bookmarks().lastInProgress(userId);
			if (!mark) return { error: result(false, 'no-title', 'Which book? `/book play <title>`; `/book library` lists them.') };
			const w = catalog().work(mark.workId);
			if (!w) return { error: result(false, 'missing', `${mark.title} is not in the library any more. Your place is kept on /book shelf.`) };
			return { work: w };
		}
		const exact = catalog().work(q);
		if (exact) return { work: exact };
		const hits = catalog().findWorks(q) || [];
		if (!hits.length) return { error: result(false, 'not-found', `Nothing in the audiobook library matches "${q}". \`/book library\` lists what is there.`) };
		const picked = pickWork(hits, q);
		if (picked.work) return { work: picked.work };
		const choices = picked.choices.slice(0, 5).map(w => ({
			id: w.id, title: w.title, author: w.author || null, narrator: w.narrator || null,
			edition: w.edition || null, percent: percentFor(userId, w)
		}));
		const lines = choices.map(c => {
			const by = c.narrator ? ` (read by ${c.narrator})` : c.edition ? ` (${c.edition})` : '';
			const pct = c.percent !== null ? ` · ${c.percent}%` : '';
			return `• \`${c.id}\` ${c.title}${by}${pct}`;
		});
		return { error: result(false, 'ambiguous', `Which one?\n${lines.join('\n')}`, { choices }) };
	}

	function catalogReady() {
		try {
			const list = catalog().works();
			return Array.isArray(list) && list.length > 0;
		} catch (_) {
			return false;
		}
	}

	function pickSpeed(mark, userId) {
		if (mark && bookModel.SPEEDS.includes(Number(mark.speed))) return Number(mark.speed);
		try { return bookmarks().lastSpeed(userId); } catch (_) { return 1; }
	}

	function shortDate(ms) {
		const d = new Date(ms);
		return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
	}

	function startedText(s, rs, mark, rewindMs) {
		const v = view(s);
		const title = v.title;
		const pct = Math.round(v.fraction * 100);
		const ch = v.chapter ? `Ch ${v.chapter.index} of ${v.chapter.count}, ` : '';
		switch (rs.mode) {
			case 'resume': {
				const rewound = rewindMs > 0 ? `, rewound ${Math.round(rewindMs / 1000)} s` : '';
				return `▶ Resuming ${title}, ${ch}${clockOf(s, v.positionMs)} (${pct}%), ${s.speed}x${rewound}`;
			}
			case 'new-material': {
				const n = rs.newParts;
				const what = v.kind === 'podcast' ? (n === 1 ? 'new episode' : 'new episodes') : (n === 1 ? 'new part' : 'new parts');
				return `▶ ${n} ${what} since you caught up: ${title}, ${s.speed}x`;
			}
			case 'restart': {
				const on = mark && Number.isFinite(mark.finishedAt) ? ` on ${shortDate(mark.finishedAt)}` : '';
				return `You finished this${on}, starting again. ▶ ${title}, ${s.speed}x`;
			}
			default:
				return `▶ Starting ${title} from the beginning, ${s.speed}x`;
		}
	}

	function kickFreshness() {
		try {
			const p = ensureFresh({ reason: 'play' });
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (_) {}
	}

	// joinVoiceChannel hands an existing Ready connection to the next caller, so a late join is
	// destroyed only when nothing newer could be using it.
	function releaseLateConnection(guildId, conn) {
		try {
			const busy = bot && typeof bot.musicBusy === 'function' && bot.musicBusy();
			if (voiceConnectionOf(guildId) === conn && !sessions.has(guildId) && !busy) conn.destroy();
		} catch (_) {}
	}

	function newSession({ guild, member, userId, work, voiceChannel, textChannel, startAbs, speed, clearFinished }) {
		const { partIndex } = bookModel.locate(work, startAbs);
		return {
			id: crypto.randomBytes(3).toString('hex'),
			guildId: guild.id,
			guild,
			userId,
			member,
			listenerName: displayName(member),
			workId: work.id,
			work,
			voiceChannelId: voiceChannel.id,
			voiceChannelName: voiceChannel.name || null,
			textChannel: textChannel || null,
			conn: undefined,
			player: undefined,
			state: 'starting',
			res: null,
			kill: null,
			resGen: 0,
			resSpeed: speed,
			lastPdAccounted: 0,
			pendingListenedMs: 0,
			pendingCoveredMs: 0,
			anchorAbsMs: startAbs,
			partIndex,
			parkedAbsMs: startAbs,
			speed,
			clearFinished: !!clearFinished,
			sleep: null,
			audible: false,
			lastAttempt: null,
			failures: [],
			card: null,
			cardEditAt: -Infinity,
			cardChain: Promise.resolve(),
			timers: { save: null, card: null, cardEdit: null, sleep: null, chapter: null, idleLeave: null, retry: null, buffering: null, reconnect: null, botMoved: null },
			lastAudioAt: null,
			pausedAt: null,
			leaveAt: null,
			pauseReason: null,
			pauseDetail: null,
			endReason: null,
			endDetail: null,
			endedAt: null,
			everPlayed: false,
			saveHealthy: true,
			lastGate: null,
			stoppedBy: null,
			onConnState: null,
			reconnectKind: null,
			reconnectSince: null,
			startedAt: now()
		};
	}

	function attach(s, conn) {
		s.conn = conn;
		const player = createPlayer();
		voiceHealth().watchPlayer(player, { kind: 'book' });
		s.player = player;
		wirePlayer(s, player);
		conn.subscribe(player);
		s.onConnState = (o, n) => onConnState(s, o, n);
		conn.on('stateChange', s.onConnState);
		s.state = 'playing';
		s.everPlayed = true;
		armSaveTimer(s);
		armCardRefresh(s);
		run(startAt(s, s.anchorAbsMs));
		editCard(s);
		// Voice state changes during the join were ignored ('starting'), and none may follow.
		if (!listenerInChannel(s)) park(s, 'listener-left');
	}

	/**
	 * /book play. Everything up to the session's creation is synchronous, so two plays cannot
	 * interleave before the claim exists. Never replies: resolves to { ok, code, text, ... } for
	 * the caller to send (the public card is posted here, on ctx.textChannel).
	 *
	 * @param {object} ctx { guild, member, userId?, textChannel, query?, workId?, work?, fromStart? }
	 * @returns {Promise<{ ok, code, text, view?, sessionId?, choices?, info? }>} code: playing,
	 *   disabled, closed, no-guild, no-voice, catalog-building, no-title, missing, not-found,
	 *   ambiguous (with choices [{ id, title, author, narrator, edition, percent }]), claimed,
	 *   music-busy, other-listener, starting, join-failed, cancelled
	 */
	async function play(ctx = {}) {
		const c = cfg();
		if (closed) return result(false, 'closed', 'Audiobooks are shutting down; try again in a moment.');
		if (!c.audiobooksEnabled) {
			return result(false, 'disabled', 'Audiobooks are turned off. The bot owner can turn them on in /config, under Audiobooks.');
		}
		const guild = ctx.guild;
		const member = ctx.member;
		const userId = String(ctx.userId || memberId(member) || '');
		if (!guild || !member || !userId) return result(false, 'no-guild', 'Run /book play in the server, from a voice channel.');
		const voiceChannel = member.voice && member.voice.channel;
		if (!voiceChannel) return result(false, 'no-voice', 'Join a voice channel first, then run /book play.');
		kickFreshness();
		if (!catalogReady()) return result(false, 'catalog-building', 'Reading the library (about 20 s). Try /book play again in a moment.');
		const found = resolveWork(ctx, userId);
		if (found.error) return found.error;
		const work = found.work;
		const guildId = guild.id;

		let claim = null;
		try { claim = voiceClaims().holder(guildId, { ignore: ['audiobook'] }); } catch (_) {}
		if (claim) return result(false, 'claimed', `🎲 ${claim.label} is using voice in this server. /book play can start once it ends.`);
		if (bot && typeof bot.musicBusy === 'function' && bot.musicBusy()) {
			return result(false, 'music-busy', 'Music is playing here. Stop it with !stop, then /book play.');
		}
		const here = sessions.get(guildId);
		if (here && here.userId !== userId) {
			return result(false, 'other-listener', `${here.listenerName} is listening to ${here.work.title} here. One book per server at a time.`);
		}
		// A double submit, or phone plus desktop.
		if (here && here.state === 'starting') return result(false, 'starting', STILL_JOINING);

		// From here on nothing awaits until the session exists, so the gate never sees a gap.
		for (const other of [...sessions.values()]) {
			if (other.userId === userId && other.guildId !== guildId) stop(other, 'switched');
		}
		// Stopped before the bookmark is read, so replaying the same book resumes where it was.
		// A switch never reuses the connection: stop() destroyed it, and an AutoPaused player on a
		// destroyed connection hangs forever.
		if (here) stop(here, 'switched');

		const mark = bookmarks().get(userId, work);
		const rs = bookModel.resumeStart(work, mark, { fromStart: !!ctx.fromStart });
		let rewindMs = 0;
		// Never at 0 or at the start of new material: that would replay the end of the old one.
		if (rs.rewind && mark && Number.isFinite(mark.lastListenedAt)) {
			rewindMs = Math.min(rs.absMs, bookModel.resumeRewindMs(now() - mark.lastListenedAt, c.audiobookResumeRewindSeconds));
		}
		const startAbs = Math.max(0, rs.absMs - rewindMs);
		const s = newSession({
			guild, member, userId, work, voiceChannel,
			textChannel: ctx.textChannel,
			startAbs,
			speed: pickSpeed(mark, userId),
			clearFinished: rs.clearFinished
		});
		sessions.set(guildId, s);
		logger.info(`Audiobook session ${s.id}: ${work.id} for ${userId} from ${bookModel.formatClock(startAbs)} (${rs.mode}).`);

		let conn;
		try {
			conn = await bot.openConnection(voiceChannel);
		} catch (err) {
			// A newer join can destroy this unfinished one; its failure then belongs to nobody.
			if (sessions.get(guildId) === s && s.state === 'starting') {
				stop(s, 'join-failed');
				return result(false, 'join-failed', 'Couldn\'t join the voice channel.');
			}
			return result(false, 'cancelled', 'Stopped before the book started.');
		}
		if (sessions.get(guildId) !== s || s.state !== 'starting') {
			releaseLateConnection(guildId, conn);
			return result(false, 'cancelled', 'Stopped before the book started.');
		}
		attach(s, conn);
		let stale = false;
		try { stale = !!library().lastError(); } catch (_) {}
		let text = startedText(s, rs, mark, rewindMs);
		// attach() parks when the listener left during the join; "Resuming" alone would contradict the card.
		if (s.state === 'paused' && s.pauseReason === 'listener-left') text += '\n⏸ Paused: you left the voice channel. Press Resume when you are back.';
		return result(true, 'playing', text, {
			sessionId: s.id,
			view: view(s),
			info: { mode: rs.mode, rewindMs, newParts: rs.newParts, startMs: startAbs, stale }
		});
	}

	// ---- gate, generic commands -----------------------------------------------------------

	/**
	 * The runPlayback gate. True while a session exists in the message's guild ('starting'
	 * included). Answers the message exactly once: every producer leaves the acknowledgement to
	 * playSong, and on the slash path this reply is what closes the "thinking…" defer.
	 */
	function blocksMusic(message) {
		const guildId = message && message.guild && message.guild.id;
		const s = guildId ? sessions.get(guildId) : null;
		if (!s) return false;
		const textChannel = message.interaction ? message.interaction.channel : message.channel;
		s.lastGate = {
			requesterId: memberId(message.member) || (message.author && message.author.id) || null,
			member: message.member || null,
			textChannel: textChannel || null
		};
		const waiting = bot && Array.isArray(bot.songQueue) ? bot.songQueue.length : 0;
		event('music-gated-by-book', { guildId, workId: s.workId, waiting });
		let content = `📚 Queued behind ${s.listenerName}'s book (${waiting} waiting).`;
		const key = (textChannel && textChannel.id) || guildId;
		const t = now();
		if (!gateExplainedAt.has(key) || t - gateExplainedAt.get(key) >= GATE_EXPLAIN_EVERY_MS) {
			gateExplainedAt.set(key, t);
			const room = s.voiceChannelName ? ` in 🔊 ${s.voiceChannelName}` : '';
			content += `\n${s.listenerName} is listening to ${s.work.title}${room}. Queued tracks play after \`/book stop\`, or run \`!play\` with no arguments then.`;
		}
		try {
			const p = message.reply({ content, allowedMentions: { parse: [] } });
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (_) {}
		return true;
	}

	/**
	 * Decision D2: !pause, !resume, !skip (next chapter) and !stop act on a book in the guild.
	 * True whenever a session exists in the guild; then it has replied, with a refusal when the
	 * caller may not act (for stop: the book keeps playing, and stop.js still clears the music
	 * queue on true). False, with no session, means the music command runs as it always did.
	 */
	function routeGeneric(cmd, message) {
		const map = { pause: 'pause', resume: 'resume', skip: 'nextch', stop: 'stop' };
		const action = map[cmd];
		if (!action || !message || !message.guild) return false;
		const s = sessions.get(message.guild.id);
		if (!s) return false;
		// Falling through would have the music command answer "Nothing is playing" over the
		// book, or announce the track queued behind it as skipped.
		let text;
		if (action === 'stop' && !canControl(s, message.member, action)) {
			const queued = bot && Array.isArray(bot.songQueue) && bot.songQueue.length > 0;
			text = `${s.listenerName}'s book keeps playing: only they can stop it, or anyone in its voice channel once they've left.${queued ? ' The music queue is cleared.' : ''}`;
		} else {
			text = controlSession(s, message.member, action, undefined, { reason: 'generic' }).text;
		}
		try {
			const p = message.reply({ content: text, allowedMentions: { parse: [] } });
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (_) {}
		return true;
	}

	// ---- shelf-side helpers ---------------------------------------------------------------

	function liveSessionOf(userId, workId) {
		for (const s of sessions.values()) {
			if (s.userId !== userId) continue;
			if (s.workId === workId) return s;
			// Renamed since the session's last save.
			let cur = null;
			try { cur = catalog().work(s.workId); } catch (_) {}
			if (cur && cur.id === workId) return s;
		}
		return null;
	}

	/**
	 * /book finish and the ended card's "Mark finished". A live session of that work ends first,
	 * with its listening time saved and no smaller position after the finish.
	 */
	function finish(userId, workOrId, { guildId } = {}) {
		const work = workOrId && typeof workOrId === 'object' ? workOrId : catalog().work(String(workOrId || ''));
		if (!work) return result(false, 'not-found', 'That book is not in the library.');
		const uid = String(userId);
		const s = liveSessionOf(uid, work.id);
		if (s) {
			const total = totalOf(s);
			try {
				save(s, { force: true, atMs: total });
				bookmarks().markFinished(uid, s.work, { guildId: s.guildId });
			} catch (err) {
				logger.error('Audiobook could not mark a work finished:', (err && err.message) || err);
			}
			stop(s, 'finished', { atMs: total });
		} else {
			bookmarks().markFinished(uid, work, { guildId });
		}
		return result(true, 'finished', `🎉 Marked ${work.title} finished.`);
	}

	/** /book forget. A live session of that work ends without saving, so it cannot write it back. */
	function forget(userId, workId) {
		const uid = String(userId);
		const id = workId && typeof workId === 'object' ? workId.id : String(workId || '');
		const s = liveSessionOf(uid, id);
		if (s) stop(s, 'forgotten');
		const r = bookmarks().forget(uid, id);
		return result(!!(r && r.removed), r && r.removed ? 'forgotten' : 'not-found', r && r.removed ? 'Forgotten.' : 'There was no bookmark for that.');
	}

	/** /book now: post the card again at the bottom; the old one turns into "moved ↓". */
	function repost(guildId, { textChannel } = {}) {
		const s = sessions.get(guildId);
		if (!s) return result(false, 'no-session', 'No book is playing in this server.');
		if (s.state === 'starting') return result(false, 'starting', STILL_JOINING);
		const old = s.card;
		s.card = null;
		if (textChannel) s.textChannel = textChannel;
		clearTimer(s, 'cardEdit');
		s.cardEditAt = now();
		enqueueCard(s, async () => {
			if (s.state === 'ended') return;
			s.card = await s.textChannel.send(card().buildCard(view(s)));
			if (old) {
				try { await old.edit(card().movedCard()); } catch (_) {}
			}
		});
		return result(true, 'ok', 'Posted.', { sessionId: s.id });
	}

	// ---- lifecycle ------------------------------------------------------------------------

	function start() {
		try {
			return library().start();
		} catch (err) {
			logger.error('Audiobook library failed to start:', (err && err.message) || err);
			return null;
		}
	}

	/** Synchronous saves, ffmpeg killed, voice left, proxy closed. Called before the queue empties. */
	function shutdown() {
		closed = true;
		for (const s of [...sessions.values()]) stop(s, 'shutdown');
		try { bookmarks().flush(); } catch (err) { logger.error('Audiobook bookmarks flush failed:', (err && err.message) || err); }
		try {
			const p = proxy().stop();
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (_) {}
		try { library().stop(); } catch (_) {}
		if (client && typeof client.removeListener === 'function') client.removeListener('voiceStateUpdate', onVoiceState);
	}

	function sessionById(id) {
		if (!id) return null;
		for (const s of sessions.values()) if (s.id === id) return s;
		return null;
	}

	return {
		start,
		play,
		control,
		controlSession,
		canControl,
		session: guildId => sessions.get(guildId) || null,
		sessionById,
		sessions: () => [...sessions.values()],
		holds: guildId => sessions.has(guildId),
		view,
		position,
		blocksMusic,
		routeGeneric,
		finish,
		forget,
		repost,
		noteCardUpdated,
		shutdown
	};
}

module.exports = { createBookDirector, BUFFERING_TIMEOUT_MS };
