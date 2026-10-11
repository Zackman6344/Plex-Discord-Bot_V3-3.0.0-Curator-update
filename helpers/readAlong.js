// helpers/readAlong.js
//
// The read-along pager: the book's text in the listener's DMs, one message edited in place and
// turned as the narration advances, plus the private page behind the card's 📖 button.
//
// Where the text comes from is helpers/bookTextSource.js; how audio time maps to a word, and a
// section to pages, is helpers/readAlongModel.js; what a page looks like is
// helpers/readAlongCard.js. This file owns the readers and their timing.
//
// Following never skips a page. A timed turn shows the page after the one on screen, never the
// estimate itself, so at 3x every page still appears in order; a page lasts about 20 s even
// then, longer than the 12 s minimum gap, so the gap only spaces out very short pages. A move
// the engine reports (a seek, a chapter, a part boundary, a resume) steps at most one page when
// the estimate is within two pages; anything further is a deliberate jump, coalesced, that goes
// straight to the estimate.
//
// The engine tells the pager when the position jumps (bookEngine onChange); between events the
// pager costs nothing but its one timer per reader. Engine events arrive synchronously inside
// engine calls, so they are only recorded there and acted on later, through the reader's chain.
//
// Book text never reaches a log line: every logger call here carries codes and ids only.

const DEFAULT_TIMERS = { setTimeout, clearTimeout, now: () => Date.now() };

const PAGE_TARGET_WORDS = 180;
const PAGE_MAX_CHARS = 1400;
const MIN_TURN_GAP_MS = 12000;
const JUMP_PAGES = 2;
const EDIT_COALESCE_MS = 1500;
const TURN_PAD_MS = 750;
const MAX_TIMER_MS = 300000;
// A timed turn that found the narration not there yet (a slow start, a speed change in flight)
// looks again after this, instead of every TURN_PAD_MS.
const RETRY_TURN_MS = 2000;
const PAGE_CACHE = 6;
// A text that is not cached yet gets this long to open before the DM says "Preparing": most
// failures (Calibre closed, no ebook) answer well inside it, and then the command reply carries
// the reason instead of a DM that has to be edited into one.
const PREPARE_WAIT_MS = 1500;
// How far the position may stray from where steady playback would have put it and still count
// as the narration flowing on (a part boundary, a speed change) rather than a seek.
const CONTINUITY_SLACK_MS = 2000;
// Hearing the word, clicking and the Discord round trip put a 📌 click about half a second to a
// second after the word began. Wall-clock time, so it is that much more audio at a higher speed.
const MARK_LAG_MS = 700;
// Where no chapter-named track is playing (hour splits, pace stretches), a 📌 counts only on a page
// in the estimate's ebook section or within this many pages of the estimate. Further off, the
// listener browsed there and the narrator is not.
const MARK_NEAR_PAGES = 10;
// A new mark this close (or on the same word) to one of the same recording and text is a second
// try at the same spot, and replaces it.
const MARK_REPLACE_MS = 20000;
// Discord's "Unknown Message" (the user deleted the page) and "Cannot send messages to this user".
const UNKNOWN_MESSAGE = 10008;
const DM_CLOSED = 50007;
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };

const STALE_TEXT = 'That book is no longer playing.';
const DM_CLOSED_TEXT = 'I can\'t DM you (your DMs are closed to this server). Use the 📖 button on the book card instead; it shows the page only to you.';
const NOT_LISTENING = 'You\'re not listening to a book right now.';
const MARK_FAR_TEXT = '📌 That page is too far from where the narrator is. Page to where the narrator is, and press 📌 when the voice reaches the page\'s first words.';
const MARK_CHAPTER_TEXT = '📌 That page is outside the chapter now playing. Press 📌 on a page of this chapter when the voice reaches its first words.';
const MARK_NO_TEXT_TEXT = '📌 The narrator is not reading the ebook here (an intro, credits, or a part the ebook leaves out). Press 📌 when the voice reaches the first words of a page.';
const MARK_NOT_PLAYING_TEXT = '📌 Marks need the book playing: press 📌 when the narrator reaches the first words of the page.';

function codeOf(err) {
	return (err && (err.code || err.name)) || 'error';
}

// The guild's voice-state cache is what the gateway keeps current; the interaction's member can
// be a raw API member with no voice at all, so it is only the fallback.
function voiceChannelIdOf(interaction, guild) {
	const uid = interaction && interaction.user && interaction.user.id;
	if (!uid) return null;
	const own = interaction.guild && interaction.guild.voiceStates ? interaction.guild : null;
	const g = own || guild;
	const cache = g && g.voiceStates && g.voiceStates.cache;
	const vs = cache && typeof cache.get === 'function' ? cache.get(String(uid)) : null;
	if (vs) return vs.channelId ? String(vs.channelId) : null;
	const voice = interaction.member && interaction.member.voice;
	const id = voice && (voice.channelId || (voice.channel && voice.channel.id));
	return id ? String(id) : null;
}

/**
 * Who may see a book's pages: the listener anywhere, anyone else only while they are in the
 * book's voice channel, since they hear the same words. Checked on every click, not once.
 * @returns {'listener'|'voice'|null}
 */
function readerAccess(s, interaction) {
	const uid = interaction && interaction.user && interaction.user.id;
	if (!s || !uid) return null;
	if (String(uid) === String(s.userId)) return 'listener';
	if (!s.voiceChannelId) return null;
	if (interaction.guildId && s.guildId && String(interaction.guildId) !== String(s.guildId)) return null;
	return voiceChannelIdOf(interaction, s.guild) === String(s.voiceChannelId) ? 'voice' : null;
}

function joinToReadText(s) {
	const where = s && s.voiceChannelId ? `<#${s.voiceChannelId}>` : 'the book\'s voice channel';
	return `🔊 Join ${where} to read along.`;
}

function createReadAlong(opts = {}) {
	const books = opts.books;
	if (!books) throw new Error('createReadAlong needs the book director');
	const client = opts.client || null;
	const model = opts.model || require('./readAlongModel.js');
	const { formatClock } = require('./bookModel.js');
	const card = opts.card || require('./readAlongCard.js');
	const store = opts.store || require('./bookTextStore.js');
	const logger = opts.logger || require('./logger.js');
	const timers = opts.timers || DEFAULT_TIMERS;
	const defer = opts.defer || (fn => setImmediate(fn));
	const cfg = () => {
		const c = typeof opts.cfg === 'function' ? opts.cfg() : opts.cfg;
		return c || require('../config/config.js');
	};
	const catalog = () => opts.catalog || require('./bookCatalogStore.js');
	const source = opts.source || require('./bookTextSource.js').createBookTextSource();
	const now = () => timers.now();
	const prefix = () => cfg().commandPrefix || '!';

	const readers = new Map();
	const texts = new Map();
	const cardShown = new Map();
	const dmNoticed = new Set();
	let closed = false;

	// ---- small helpers ---------------------------------------------------------------------

	function later(ms, fn) {
		const h = timers.setTimeout(() => {
			try {
				fn();
			} catch (err) {
				logger.warn('Read-along timer failed:', codeOf(err));
			}
		}, Math.max(0, ms));
		if (h && typeof h.unref === 'function') h.unref();
		return h;
	}

	function clearTurn(r) {
		if (r.timers.turn) {
			try { timers.clearTimeout(r.timers.turn); } catch (_) {}
			r.timers.turn = null;
		}
	}

	function clearCoalesce(r) {
		if (r.timers.coalesce) {
			try { timers.clearTimeout(r.timers.coalesce); } catch (_) {}
			r.timers.coalesce = null;
		}
	}

	function titleOf(s) {
		return (s && s.work && s.work.title) || (s && s.workId) || 'this book';
	}

	function esc(text) {
		return String(text === null || text === undefined ? '' : text).replace(/([\\*_`~|])/g, '\\$1');
	}

	function liveSessionOf(userId) {
		const uid = String(userId || '');
		let list = [];
		try { list = books.sessions() || []; } catch (_) {}
		return list.find(x => String(x.userId) === uid && x.state !== 'ended' && x.state !== 'starting') || null;
	}

	function statusOf(s) {
		try {
			return source.status(s.work);
		} catch (_) {
			return 'unknown';
		}
	}

	function newReader(s) {
		return {
			userId: String(s.userId),
			sid: s.id,
			workId: s.workId,
			message: null,
			follow: true,
			shown: null,
			shownTag: null,
			pin: null,
			lastTurnAt: -Infinity,
			lastJumpAt: -Infinity,
			lastPos: null,
			lastPosAt: 0,
			lastState: null,
			lastSpeed: 1,
			lastRenderKey: null,
			pendingNote: null,
			chain: Promise.resolve(),
			timers: { turn: null, coalesce: null },
			inControl: false,
			dead: false
		};
	}

	function drop(r) {
		r.dead = true;
		clearTurn(r);
		clearCoalesce(r);
		if (readers.get(r.userId) === r) readers.delete(r.userId);
	}

	function liveFor(r, s) {
		return !closed && !r.dead && readers.get(r.userId) === r && !!s && r.sid === s.id && s.state !== 'ended';
	}

	function serial(r, fn) {
		r.chain = r.chain.then(() => (r.dead ? null : fn())).catch((err) => {
			logger.warn('Read-along page update failed:', codeOf(err));
		});
		return r.chain;
	}

	// A last edit after the reader is gone (ended, off): queued behind any edit in flight.
	function finalEdit(r, payload) {
		const msg = r.message;
		drop(r);
		if (!msg || typeof msg.edit !== 'function') return r.chain;
		r.chain = r.chain.then(() => msg.edit(payload)).catch((err) => {
			if (!err || (err.code !== UNKNOWN_MESSAGE && err.code !== DM_CLOSED)) logger.warn('Read-along could not close a DM page:', codeOf(err));
		});
		return r.chain;
	}

	async function edit(r, payload) {
		if (!r.message || r.dead) return;
		try {
			await r.message.edit(payload);
		} catch (err) {
			if (err && (err.code === UNKNOWN_MESSAGE || err.code === DM_CLOSED)) {
				drop(r);
				return;
			}
			logger.warn('Read-along could not edit a DM page:', codeOf(err));
		}
	}

	async function sendDm(userId, payload) {
		if (!client || !client.users || typeof client.users.fetch !== 'function') {
			throw Object.assign(new Error('no client'), { code: 'no-client' });
		}
		const user = await client.users.fetch(String(userId));
		const dm = await user.createDM();
		return dm.send(payload);
	}

	// ---- the text of a work ----------------------------------------------------------------

	// The session's own parts carry the positions; the catalog's copy may know the publisher (the
	// "dramatized" label) when the session started before the catalog rebuild that added it.
	function mapWork(s) {
		let cur = null;
		try { cur = catalog().work(s.workId); } catch (_) {}
		return Object.assign({}, s.work, { publisher: (s.work && s.work.publisher) || (cur && cur.publisher) || null });
	}

	// Marks are kept per recording under the catalog's current id and its aliases, so the
	// catalog's copy of the work (renamed since the session started) is the key when it has one.
	function workRef(s) {
		let cur = null;
		try { cur = catalog().work(s.workId); } catch (_) {}
		return cur || s.work || s.workId;
	}

	// Only the marks made against this exact text and recording: a word index means nothing in
	// another parse, and an audio time nothing in another narration filed under the same id.
	function marksOf(s, base) {
		if (!store.marks || typeof store.marks.list !== 'function') return [];
		let list = [];
		try { list = store.marks.list(workRef(s)) || []; } catch (_) {}
		const rec = model.recordingOf(s.work);
		return list.filter(m => m.text === base && model.sameRecording(m.rec, rec)).map(m => ({ id: m.id, ms: m.ms, word: m.word, at: m.at }));
	}

	async function textFor(s, { explicit = false } = {}) {
		let res;
		try {
			res = await source.open(s.work, { explicit });
		} catch (err) {
			logger.warn('Read-along could not open a text:', codeOf(err));
			return { ok: false, code: 'error', text: 'Reading the text failed; check the bot log.' };
		}
		if (!res || !res.ok) return { ok: false, code: res && res.code, text: (res && res.text) || 'There is no text for this book.' };
		const h = res.handle;
		let t = texts.get(s.workId);
		const marks = marksOf(s, h.base);
		const marksKey = marks.map(m => `${m.id}@${m.ms}=${m.word}`).join(',');
		if (t && t.base === h.base && t.parts === s.work.parts && t.marksKey !== marksKey) {
			// Marks move anchors only: the sections, the body and the cached pages stay as they are.
			try {
				const map = model.buildMap(mapWork(s), h.index, { extraAnchors: marks });
				if (map) {
					t.map = map;
					t.marksKey = marksKey;
					t.rev++;
				}
			} catch (err) {
				logger.warn('Read-along could not line the text up with the audio:', codeOf(err));
			}
		}
		if (!t || t.base !== h.base || t.parts !== s.work.parts) {
			let map = null;
			try {
				map = model.buildMap(mapWork(s), h.index, { extraAnchors: marks });
			} catch (err) {
				logger.warn('Read-along could not line the text up with the audio:', codeOf(err));
			}
			const body = [];
			if (map) {
				for (let i = 0; i < map.sections.length; i++) {
					const x = map.sections[i];
					if (x.matter === 'body' && x.words > 0) body.push(i);
				}
			}
			if (!map || !body.length) return { ok: false, code: 'no-body', text: 'This ebook has no chapters I can line up with the audio.' };
			t = { base: h.base, tag: h.tag, handle: h, map, marksKey, rev: 0, parts: s.work.parts, body, bodyPos: new Map(body.map((sec, i) => [sec, i])), pages: new Map() };
			texts.set(s.workId, t);
		}
		return { ok: true, t, stale: !!res.stale };
	}

	async function pagesOf(t, sec) {
		let hit = t.pages.get(sec);
		if (hit) {
			t.pages.delete(sec);
			t.pages.set(sec, hit);
			return hit;
		}
		hit = t.handle.readSection(sec).then(text => ({
			text,
			pages: model.paginate(text, { targetWords: PAGE_TARGET_WORDS, maxChars: PAGE_MAX_CHARS })
		}));
		t.pages.set(sec, hit);
		while (t.pages.size > PAGE_CACHE) t.pages.delete(t.pages.keys().next().value);
		try {
			return await hit;
		} catch (err) {
			if (t.pages.get(sec) === hit) t.pages.delete(sec);
			throw err;
		}
	}

	function refAt(t, sec, page, pages) {
		const start = t.map.sections[sec].wordStart;
		const p = pages[page];
		return { kind: 'page', sec, page, word: start + p.startWord, endWord: start + p.endWord };
	}

	async function pageForWord(t, word) {
		const loc = model.locate(t.map, word);
		if (!loc) return null;
		const { pages } = await pagesOf(t, loc.section);
		return refAt(t, loc.section, model.pageAt(pages, loc.wordInSection), pages);
	}

	function noTextRef(t, pos, word) {
		const seg = t.map.segments.find(x => x.level !== 'none' && x.fromMs >= pos);
		const loc = seg ? model.locate(t.map, seg.fromWord) : null;
		const label = loc ? String(t.map.sections[loc.section].label || '').trim() : '';
		const bk = model.bookAt(t.map, pos);
		return {
			kind: 'none',
			word: seg ? seg.fromWord : word,
			resumeMs: seg ? seg.fromMs : null,
			resumesAt: seg ? (label || 'the next chapter') : null,
			notInEbook: bk && bk.ebookTitle === null ? `Book ${bk.number}${bk.title ? `: ${bk.title}` : ''}` : null
		};
	}

	function sample(r, s) {
		r.lastPos = books.position(s);
		r.lastPosAt = now();
		r.lastState = s.state;
		r.lastSpeed = s.speed > 0 ? s.speed : 1;
	}

	// Steady playback only ever moves forward, at most as fast as the clock times the speed, and
	// not at all while paused. Within that, a display several pages behind (a run of very short
	// pages) is narration flowing on and is caught up one page per turn, never skipped.
	function continuous(r, s, pos) {
		if (!Number.isFinite(r.lastPos)) return false;
		const rate = r.lastState === 'playing' ? Math.max(r.lastSpeed, s.speed > 0 ? s.speed : 1) : 0;
		const reach = r.lastPos + Math.max(0, now() - r.lastPosAt) * rate + CONTINUITY_SLACK_MS;
		return pos >= r.lastPos - CONTINUITY_SLACK_MS && pos <= reach;
	}

	async function estimate(s, t) {
		const pos = books.position(s);
		const est = model.msToWord(t.map, pos);
		if (est.level === 'none') return noTextRef(t, pos, est.word);
		return (await pageForWord(t, est.word)) || noTextRef(t, pos, est.word);
	}

	async function stepFrom(t, ref, dir) {
		if (!ref) return null;
		if (ref.kind === 'none') {
			const base = await pageForWord(t, ref.word);
			if (dir > 0) return base;
			// Past the end of the text the word sits inside the last page, which is the one before.
			return base && ref.word > base.word ? base : stepFrom(t, base, -1);
		}
		const { pages } = await pagesOf(t, ref.sec);
		const p = ref.page + dir;
		if (p >= 0 && p < pages.length) return refAt(t, ref.sec, p, pages);
		const j = dir > 0 ? t.body.find(x => x > ref.sec) : [...t.body].reverse().find(x => x < ref.sec);
		if (j === undefined) return null;
		const next = (await pagesOf(t, j)).pages;
		return refAt(t, j, dir > 0 ? 0 : next.length - 1, next);
	}

	// Pages from b forward to a in reading order; negative when a is behind; null when either is
	// a no-text stretch. Stops counting once past JUMP_PAGES.
	async function ahead(t, a, b) {
		if (!a || !b) return null;
		if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind && a.word === b.word ? 0 : null;
		if (a.sec === b.sec) return a.page - b.page;
		if (a.word < b.word) return -1;
		let n = (await pagesOf(t, b.sec)).pages.length - b.page;
		for (const j of t.body) {
			if (j <= b.sec) continue;
			if (j >= a.sec) break;
			n += (await pagesOf(t, j)).pages.length;
			if (n > JUMP_PAGES) return n;
		}
		return n + a.page;
	}

	function edges(t, ref, pages) {
		const first = t.body[0];
		const last = t.body[t.body.length - 1];
		return {
			prevOk: ref.page > 0 || ref.sec > first,
			nextOk: ref.page < pages.length - 1 || ref.sec < last
		};
	}

	async function payloadFor(s, t, ref, { surface, mode, note = null, extra = null, viewerId }) {
		const isListener = String(viewerId) === String(s.userId);
		const bookTitle = titleOf(s);
		if (ref.kind === 'none') {
			return card.noTextPayload({
				surface, sid: s.id, tag: t.tag, word: ref.word, bookTitle, resumesAt: ref.resumesAt, notInEbook: ref.notInEbook,
				mode, note, isListener, dramatized: t.map.dramatized
			});
		}
		const { text, pages } = await pagesOf(t, ref.sec);
		const p = pages[ref.page] || pages[0];
		const sec = t.map.sections[ref.sec];
		const pos = t.bodyPos.get(ref.sec);
		return card.pagePayload(Object.assign({
			surface,
			sid: s.id,
			tag: t.tag,
			word: ref.word,
			page: ref.page,
			pageCount: pages.length,
			sectionLabel: sec.label,
			sectionNo: pos === undefined ? 0 : pos + 1,
			sectionCount: t.body.length,
			bookTitle,
			text: text.slice(p.startChar, p.endChar),
			quality: model.qualityAt(t.map, model.wordToMs(t.map, ref.word)),
			dramatized: t.map.dramatized,
			mode,
			note,
			extra,
			isListener,
			isPaused: s.state === 'paused'
		}, edges(t, ref, pages)));
	}

	// ---- following -------------------------------------------------------------------------

	function modeOf(r, s) {
		if (!r.follow) return 'browsing';
		return s.state === 'paused' ? 'paused' : 'following';
	}

	// The map's revision is part of the key, so a mark (anyone's, on this recording) re-renders
	// every open page of it on that page's next event, sync level and all.
	function renderKey(s, t, ref, mode, note, extra = null) {
		return `${s.id}|${t.tag}|${t.rev || 0}|${ref.kind}|${ref.word}|${mode}|${note || ''}|${extra || ''}`;
	}

	async function render(r, s, t, ref, mode, note = null, extra = null) {
		r.shown = ref;
		r.shownTag = t.tag;
		const k = renderKey(s, t, ref, mode, note, extra);
		if (k === r.lastRenderKey) return false;
		const payload = await payloadFor(s, t, ref, { surface: 'd', mode, note, extra, viewerId: r.userId });
		if (r.dead) return false;
		r.lastRenderKey = k;
		await edit(r, payload);
		return true;
	}

	// While ↪ is pinned, an estimate up to one page short of the pinned page shows it: float and
	// engine rounding must never put the previous page back up.
	function applyPin(r, est) {
		const pin = r.pin;
		if (!pin) return est;
		if (est && est.kind === 'page' && est.word >= pin.word - (pin.endWord - pin.word) && est.word < pin.endWord) return pin.ref;
		r.pin = null;
		return est;
	}

	function schedule(r, s, t, { floor = 0 } = {}) {
		clearTurn(r);
		if (!liveFor(r, s) || !r.follow || !r.shown || s.state !== 'playing' || !s.audible) return;
		let target;
		if (r.shown.kind === 'none') {
			if (!Number.isFinite(r.shown.resumeMs)) return;
			target = r.shown.resumeMs;
		} else {
			if (r.shown.endWord >= t.map.bodyEndWord) return;
			target = model.wordToMs(t.map, r.shown.endWord);
		}
		const speed = s.speed > 0 ? s.speed : 1;
		let delay = Math.max(0, (target - books.position(s)) / speed) + TURN_PAD_MS;
		delay = Math.max(delay, r.lastTurnAt + MIN_TURN_GAP_MS - now(), floor);
		delay = Math.min(delay, MAX_TIMER_MS);
		r.timers.turn = later(delay, () => {
			r.timers.turn = null;
			serial(r, () => turn(r, s));
		});
	}

	// A failed turn (a section read that hit EBUSY) leaves no timer behind, and inside one long
	// track the engine's next event may be most of an hour away, so it tries again by itself.
	async function turn(r, s) {
		try {
			await turnOnce(r, s);
		} catch (err) {
			logger.warn('Read-along page turn failed:', codeOf(err));
			if (!liveFor(r, s) || !r.follow || s.state !== 'playing' || r.timers.turn || r.timers.coalesce) return;
			r.timers.turn = later(MIN_TURN_GAP_MS, () => {
				r.timers.turn = null;
				serial(r, () => turn(r, s));
			});
		}
	}

	async function turnOnce(r, s) {
		if (!liveFor(r, s) || !r.follow || !r.message || !r.shown || s.state !== 'playing') return;
		const got = await textFor(s);
		if (!got.ok) return textGone(r, got);
		const t = got.t;
		if (r.shownTag !== t.tag) {
			await jumpNow(r, s, { note: 'text-updated' });
			return;
		}
		sample(r, s);
		const est = applyPin(r, await estimate(s, t));
		let target = null;
		if (r.shown.kind === 'none' || est.kind === 'none') {
			if (est.kind !== r.shown.kind || est.word !== r.shown.word) target = est;
		} else {
			const n = await ahead(t, est, r.shown);
			if (n !== null && n >= 1) target = await stepFrom(t, r.shown, 1);
		}
		if (target && liveFor(r, s)) {
			await render(r, s, t, target, 'following');
			r.lastTurnAt = now();
		}
		schedule(r, s, t, { floor: target ? 0 : RETRY_TURN_MS });
	}

	async function jumpNow(r, s, { note = null } = {}) {
		if (!liveFor(r, s) || !r.message) return;
		const got = await textFor(s);
		if (!got.ok) return textGone(r, got);
		const t = got.t;
		const n = note || r.pendingNote || (r.shownTag && r.shownTag !== t.tag ? 'text-updated' : null);
		r.pendingNote = null;
		r.lastJumpAt = now();
		if (r.shownTag && r.shownTag !== t.tag) r.pin = null;
		sample(r, s);
		const est = applyPin(r, await estimate(s, t));
		if (!liveFor(r, s)) return;
		await render(r, s, t, est, modeOf(r, s), n);
		r.lastTurnAt = now();
		schedule(r, s, t);
	}

	// At most one jump render per EDIT_COALESCE_MS, with a trailing one so the last move shows.
	function requestJump(r, s, note = null) {
		clearTurn(r);
		if (note) r.pendingNote = note;
		if (r.timers.coalesce) return;
		const wait = r.lastJumpAt + EDIT_COALESCE_MS - now();
		if (wait <= 0) {
			r.lastJumpAt = now();
			serial(r, () => jumpNow(r, s));
			return;
		}
		r.timers.coalesce = later(wait, () => {
			r.timers.coalesce = null;
			serial(r, () => jumpNow(r, s));
		});
	}

	async function onMove(r, s) {
		if (!liveFor(r, s) || !r.follow || !r.message || !r.shown) return;
		const got = await textFor(s);
		if (!got.ok) return textGone(r, got);
		const t = got.t;
		if (r.shownTag !== t.tag) {
			requestJump(r, s, 'text-updated');
			return;
		}
		const flowing = continuous(r, s, books.position(s));
		sample(r, s);
		// The pin only absorbs rounding around ↪'s own landing; a seek (back 30, a chapter) is
		// the listener moving on from it.
		if (!flowing) r.pin = null;
		const est = applyPin(r, await estimate(s, t));
		const n = await ahead(t, est, r.shown);
		if (n === null || n < 0 || (n > JUMP_PAGES && !flowing)) {
			requestJump(r, s);
			return;
		}
		// A step here is a turn like a timed one, so it keeps the same gap; inside the gap the
		// turn timer takes it.
		let target = r.shown;
		if (n >= 1 && now() - r.lastTurnAt >= MIN_TURN_GAP_MS) target = (await stepFrom(t, r.shown, 1)) || r.shown;
		const turned = target !== r.shown;
		if (!liveFor(r, s)) return;
		await render(r, s, t, target, modeOf(r, s));
		if (turned) r.lastTurnAt = now();
		schedule(r, s, t);
	}

	async function onPaused(r, s) {
		if (!liveFor(r, s) || !r.follow || !r.message || !r.shown) return;
		const got = await textFor(s);
		if (!got.ok) return textGone(r, got);
		if (r.shownTag !== got.t.tag) {
			await jumpNow(r, s, { note: 'text-updated' });
			return;
		}
		await render(r, s, got.t, r.shown, modeOf(r, s));
	}

	// The read-along was switched off (in /config, or for this book with !book link off) while a
	// page was open: the page says so and stops. Anything else (Calibre closed) keeps the page.
	function textGone(r, got) {
		if (got && (got.code === 'disabled' || got.code === 'off')) finalEdit(r, card.noticePayload(`📕 ${got.text}`));
	}

	function endReader(r, s) {
		finalEdit(r, card.endedStub({ bookTitle: titleOf(s) }));
	}

	function onEngine(s, kind) {
		if (closed || !s) return;
		if (kind === 'started') {
			defer(() => {
				onStarted(s).catch(err => logger.warn('Read-along could not start for a book:', codeOf(err)));
			});
			return;
		}
		if (kind === 'ended') {
			cardShown.delete(s.id);
			dmNoticed.delete(s.id);
		}
		const r = readers.get(String(s.userId));
		if (!r || r.dead || r.sid !== s.id) return;
		if (kind === 'ended') {
			endReader(r, s);
			return;
		}
		// ↪ sets the reader's state itself before it calls the engine.
		if (r.inControl) return;
		if (kind === 'paused') {
			clearTurn(r);
			sample(r, s);
			serial(r, () => onPaused(r, s));
			return;
		}
		if ((kind === 'moved' || kind === 'audible') && r.follow) serial(r, () => onMove(r, s));
	}

	// ---- the card's 📖 ---------------------------------------------------------------------

	function cardInfo(s) {
		const st = s ? statusOf(s) : 'unknown';
		const button = (st === 'ready' || st === 'available') && !(s.work && s.work.kind === 'podcast');
		if (s && s.id) cardShown.set(s.id, button);
		return { button };
	}

	// Only once the card has rendered: until then its first render reads the status itself.
	function refreshCardIfChanged(s) {
		if (!s || s.state === 'ended' || !cardShown.has(s.id)) return;
		const st = statusOf(s);
		const button = (st === 'ready' || st === 'available') && !(s.work && s.work.kind === 'podcast');
		if (cardShown.get(s.id) === button) return;
		try { books.refreshCard(s); } catch (_) {}
	}

	async function onStarted(s) {
		if (closed || s.state === 'ended') return;
		let st = 'unknown';
		try {
			st = await source.probe(s.work);
		} catch (err) {
			logger.warn('Read-along probe failed:', codeOf(err));
		}
		if (closed || s.state === 'ended') return;
		refreshCardIfChanged(s);
		if (st !== 'ready' && st !== 'available') return;
		if (s.work && s.work.kind === 'podcast') return;
		let on = false;
		try { on = store.readers.isOn(String(s.userId)); } catch (_) {}
		if (!on) return;
		const r = readers.get(String(s.userId));
		if (r && !r.dead && r.sid === s.id) return;
		await openPage(s, { auto: true });
	}

	// ---- DM pages --------------------------------------------------------------------------

	function dmClosedNotice(s) {
		if (dmNoticed.has(s.id) || !s.textChannel || typeof s.textChannel.send !== 'function') return;
		dmNoticed.add(s.id);
		const name = esc(s.listenerName || 'Listener');
		const content = `📖 ${name}: I can't DM you the book's text. Open your DMs for this server, or use the 📖 button on the card.`;
		Promise.resolve()
			.then(() => s.textChannel.send({ content, allowedMentions: NO_PINGS }))
			.catch(err => logger.warn('Read-along could not post the closed-DMs note:', codeOf(err)));
	}

	async function openPage(s, { auto = false } = {}) {
		const uid = String(s.userId);
		const existing = readers.get(uid);
		if (existing && !existing.dead && existing.sid === s.id) {
			return { ok: true, code: 'already', text: `📩 Your page is already in your DMs. \`${prefix()}book text now\` sends it again at the bottom.` };
		}
		if (existing) drop(existing);
		const r = newReader(s);
		readers.set(uid, r);
		const title = titleOf(s);
		let opening;
		let ready;
		let first;
		let t = null;
		let ref = null;
		// A reader left in the map with no message would answer "already in your DMs" to every
		// later !book text on or now for the rest of the session.
		try {
			const cached = statusOf(s) === 'ready';
			opening = textFor(s, { explicit: !auto });
			const got = cached
				? await opening
				: await Promise.race([opening, new Promise(res => later(PREPARE_WAIT_MS, () => res(null)))]);
			ready = !!got;
			if (got && !got.ok) {
				drop(r);
				return { ok: false, code: got.code, text: got.text };
			}
			if (ready) {
				t = got.t;
				sample(r, s);
				ref = await estimate(s, t);
				first = await payloadFor(s, t, ref, { surface: 'd', mode: modeOf(r, s), viewerId: uid });
			} else {
				first = card.preparingPayload({ bookTitle: title });
			}
		} catch (err) {
			drop(r);
			logger.warn('Read-along could not prepare a DM page:', codeOf(err));
			return { ok: false, code: 'error', text: 'Reading the text failed; check the bot log.' };
		}
		if (r.dead) return { ok: false, code: 'no-session', text: NOT_LISTENING };
		let msg;
		try {
			msg = await sendDm(uid, first);
		} catch (err) {
			drop(r);
			if (err && err.code === DM_CLOSED) {
				if (auto) dmClosedNotice(s);
				return { ok: false, code: 'dm-closed', text: DM_CLOSED_TEXT };
			}
			logger.warn('Read-along could not open a DM:', codeOf(err));
			return { ok: false, code: 'dm-failed', text: 'I couldn\'t send you a DM just now. Try again in a moment.' };
		}
		if (r.dead || s.state === 'ended') {
			drop(r);
			try { await msg.edit(card.endedStub({ bookTitle: title })); } catch (_) {}
			return { ok: false, code: 'no-session', text: NOT_LISTENING };
		}
		r.message = msg;
		if (ready) {
			r.shown = ref;
			r.shownTag = t.tag;
			r.lastRenderKey = renderKey(s, t, ref, modeOf(r, s), null);
			r.lastTurnAt = now();
			schedule(r, s, t);
			// A seek while the DM was on its way was dropped (no message to edit yet), and the
			// turns from here would only walk one page at a time towards it.
			if (!continuous(r, s, books.position(s))) requestJump(r, s);
			return { ok: true, code: 'sent', text: '📩 Sent to your DMs.' };
		}
		serial(r, async () => {
			const late = await opening;
			if (!late.ok) {
				const m = r.message;
				drop(r);
				try { await m.edit(card.noticePayload(`📖 ${esc(title)}: ${late.text}`)); } catch (_) {}
				return;
			}
			await jumpNow(r, s);
		});
		return { ok: true, code: 'preparing', text: '📩 Preparing the text in your DMs (first time only; it can take a minute).' };
	}

	async function turnOn({ userId } = {}) {
		const uid = String(userId || '');
		if (!uid) return { ok: false, code: 'no-user', text: 'Who is asking?' };
		try { store.readers.set(uid, true); } catch (_) {}
		const s = liveSessionOf(uid);
		if (!s) return { ok: true, code: 'on', text: '📖 Read-along is on. The next book you play opens a page in your DMs.' };
		if (s.work && s.work.kind === 'podcast') return { ok: true, code: 'podcast', text: '📖 Read-along is on. It starts with your next book (podcasts have no text).' };
		return openPage(s, { auto: false });
	}

	async function turnOff(userId) {
		const uid = String(userId || '');
		try { store.readers.set(uid, false); } catch (_) {}
		const r = readers.get(uid);
		if (r) finalEdit(r, card.offStub({ prefix: prefix() }));
		return { ok: true, code: 'off', text: '📕 Read-along is off.' };
	}

	async function sendNow(userId) {
		const uid = String(userId || '');
		let on = false;
		try { on = store.readers.isOn(uid); } catch (_) {}
		if (!on) return { ok: false, code: 'off', text: `📕 Read-along is off. \`${prefix()}book text on\` turns it on.` };
		const s = liveSessionOf(uid);
		if (!s) return { ok: false, code: 'no-session', text: NOT_LISTENING };
		const r = readers.get(uid);
		if (!r || r.dead || r.sid !== s.id || !r.message) return openPage(s, { auto: false });
		let out = null;
		await serial(r, async () => {
			const got = await textFor(s, { explicit: true });
			if (!got.ok) {
				out = { ok: false, code: got.code, text: got.text };
				return;
			}
			const t = got.t;
			r.follow = true;
			r.pin = null;
			clearCoalesce(r);
			sample(r, s);
			const ref = await estimate(s, t);
			const mode = modeOf(r, s);
			const payload = await payloadFor(s, t, ref, { surface: 'd', mode, viewerId: uid });
			let msg;
			try {
				msg = await sendDm(uid, payload);
			} catch (err) {
				out = err && err.code === DM_CLOSED
					? { ok: false, code: 'dm-closed', text: DM_CLOSED_TEXT }
					: { ok: false, code: 'dm-failed', text: 'I couldn\'t send you a DM just now. Try again in a moment.' };
				return;
			}
			// The book ended or the read-along was turned off during the send: the old page got
			// its stub already, and the fresh one would keep its text and buttons with no reader.
			if (!liveFor(r, s)) {
				let stillOn = false;
				try { stillOn = store.readers.isOn(uid); } catch (_) {}
				try { await msg.edit(stillOn ? card.endedStub({ bookTitle: titleOf(s) }) : card.offStub({ prefix: prefix() })); } catch (_) {}
				out = stillOn
					? { ok: false, code: 'no-session', text: NOT_LISTENING }
					: { ok: false, code: 'off', text: '📕 Read-along is off.' };
				return;
			}
			const old = r.message;
			r.message = msg;
			r.shown = ref;
			r.shownTag = t.tag;
			r.lastRenderKey = renderKey(s, t, ref, mode, null);
			r.lastTurnAt = now();
			try { await old.edit(card.movedStub()); } catch (_) {}
			schedule(r, s, t);
			out = { ok: true, code: 'sent', text: '📩 Sent a fresh page to your DMs.' };
		});
		return out || { ok: false, code: 'error', text: 'That did not work; check the bot log.' };
	}

	function shortDate(ms) {
		const d = new Date(ms);
		return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}`;
	}

	async function status(userId) {
		const uid = String(userId || '');
		const p = prefix();
		let on = false;
		try { on = store.readers.isOn(uid); } catch (_) {}
		const lines = [on
			? `📖 Read-along is **on** for you (\`${p}book text off\` turns it off).`
			: `📕 Read-along is **off** for you (\`${p}book text on\` sends the book's text to your DMs).`];
		const s = liveSessionOf(uid);
		if (!s) {
			lines.push(NOT_LISTENING);
			return lines.join('\n');
		}
		const title = esc(titleOf(s));
		if (s.work && s.work.kind === 'podcast') {
			lines.push(`🎧 ${title} is a podcast, so there is no text.`);
			return lines.join('\n');
		}
		let st = statusOf(s);
		if (st !== 'ready') {
			try { st = await source.probe(s.work); } catch (_) { st = 'unknown'; }
		}
		if (st === 'available') {
			lines.push(`📚 ${title}: an ebook was found. Its text is read the first time it is opened (\`${p}book text on\` or 📖 on the card).`);
			return lines.join('\n');
		}
		const got = await textFor(s, { explicit: true });
		if (!got.ok) {
			lines.push(`📚 ${title}: ${got.text}`);
			return lines.join('\n');
		}
		const t = got.t;
		const idx = t.handle.index || {};
		const words = Number(idx.totalWords || t.map.totalWords || 0).toLocaleString('en-US');
		const when = Number.isFinite(idx.builtAt) ? `, read ${shortDate(idx.builtAt)}` : '';
		const stale = got.stale ? ' (a cached copy: the source isn\'t answering)' : '';
		lines.push(`📚 ${title}: text from ${t.handle.label}, ${words} words${when}${stale}.`);
		const share = Math.round((t.map.matchedMsShare || 0) * 100);
		const sync = share >= 1
			? `chapter-level for ${share}% of the audio, estimated from pace elsewhere`
			: 'estimated from pace (no track is named after a chapter)';
		const drama = t.map.dramatized ? '; dramatized edition, so the wording can differ from the audio' : '';
		lines.push(`🔗 Sync: ${sync}. Approximate${drama}.`);
		const used = t.map.marks ? t.map.marks.used.length : 0;
		if (used) lines.push(`📌 ${used} sync mark${used === 1 ? '' : 's'} on this recording (\`${p}book marks\`).`);
		const r = readers.get(uid);
		if (r && !r.dead && r.sid === s.id && r.message) lines.push('📩 Your page is in your DMs.');
		return lines.join('\n');
	}

	// ---- buttons ---------------------------------------------------------------------------

	async function ephemeralFor(s, viewerId, at = null) {
		if (!s || s.state === 'ended') return card.noticePayload(STALE_TEXT);
		const got = await textFor(s, { explicit: true });
		if (!got.ok) return card.noticePayload(`📖 ${got.text}`);
		const ref = at || await estimate(s, got.t);
		return payloadFor(s, got.t, ref, { surface: 'e', mode: 'snapshot', viewerId });
	}

	async function answer(interaction, payload, report) {
		report(payload);
		try {
			await interaction.editReply(payload);
		} catch (err) {
			logger.warn('Read-along could not answer a button:', codeOf(err));
		}
	}

	async function followUp(interaction, text, report) {
		const payload = { content: text, flags: EPHEMERAL, allowedMentions: NO_PINGS };
		report(payload);
		try {
			await interaction.followUp(payload);
		} catch (err) {
			logger.warn('Read-along could not follow up on a button:', codeOf(err));
		}
	}

	function listenerReader(s, userId) {
		if (String(userId) !== String(s.userId)) return null;
		const r = readers.get(String(userId));
		return r && !r.dead && r.sid === s.id && r.message ? r : null;
	}

	// The engine notifies 'moved' synchronously inside controlSession, so the reader's pin, page
	// and follow flag are set before the call and its events are ignored until it returns. A
	// paused book is resumed first: a parked goto only moves the place, and the resume's rewind is
	// superseded by the goto's own start.
	function playFromHere(s, user, t, P, r) {
		const before = r ? { follow: r.follow, shown: r.shown, shownTag: r.shownTag } : null;
		if (r) {
			clearTurn(r);
			clearCoalesce(r);
			r.follow = true;
			r.pin = { ref: P, word: P.word, endWord: P.endWord };
			r.shown = P;
			r.shownTag = t.tag;
			r.inControl = true;
		}
		const ms = model.wordToMs(t.map, P.word);
		let res;
		try {
			if (s.state === 'paused') {
				res = books.controlSession(s, user, 'resume');
				if (res && res.ok) res = books.controlSession(s, user, 'goto', { mode: 'absolute', ms });
			} else {
				res = books.controlSession(s, user, 'goto', { mode: 'absolute', ms });
			}
		} catch (err) {
			logger.warn('Read-along play from here failed:', codeOf(err));
			res = { ok: false, code: 'error', text: 'That did not work; the card shows where the book is.' };
		} finally {
			if (r) r.inControl = false;
		}
		// Refused: the page on screen never changed, so neither does what the reader thinks it shows.
		if ((!res || !res.ok) && r) Object.assign(r, before, { pin: null });
		else if (r) sample(r, s);
		return res || { ok: false, code: 'error', text: 'That did not work.' };
	}

	async function onEphemeralButton(interaction, id, report) {
		const uid = String(interaction.user && interaction.user.id);
		const s = books.sessionById(id.sid);
		if (!s || s.state === 'ended') return answer(interaction, card.noticePayload(STALE_TEXT), report);
		const access = readerAccess(s, interaction);
		// readAlongButtons gates 📖 the same way, so this catches a member who left the voice
		// channel since their last click, or a forged or replayed id. The page they had becomes
		// the refusal, so no text stays on screen and no button is left to press.
		if (!access) return answer(interaction, card.noticePayload(joinToReadText(s)), report);
		const listener = access === 'listener';
		// Their page never offers these; the engine refuses a goto from anyone else too.
		if (!listener && (id.act === 'play' || id.act === 'dm')) {
			const name = esc(s.listenerName || 'the listener');
			await followUp(interaction, id.act === 'play'
				? `↪️ Only ${name} can move their book.`
				: `📩 Following in DMs is for ${name}, the listener; the 📖 page is yours while you're in the voice channel.`, report);
			return null;
		}
		// No ephemeral page offers 📌: a mark is set from the listener's own DM page.
		if (id.act === 'mark') {
			await followUp(interaction, listener
				? `📌 Marks are set from your DM page (\`${prefix()}book text on\`).`
				: `📌 Only ${esc(s.listenerName || 'the listener')}, the listener, can set marks.`, report);
			return null;
		}
		const got = await textFor(s, { explicit: true });
		if (!got.ok) return answer(interaction, card.noticePayload(`📖 ${got.text}`), report);
		const t = got.t;
		if (id.tag !== t.tag) {
			const est = await estimate(s, t);
			return answer(interaction, await payloadFor(s, t, est, { surface: 'e', mode: 'snapshot', note: 'text-updated', viewerId: uid }), report);
		}
		let ref = (await pageForWord(t, id.word)) || await estimate(s, t);
		if (id.act === 'prev' || id.act === 'next') {
			const from = id.none ? { kind: 'none', word: id.word } : ref;
			ref = (await stepFrom(t, from, id.act === 'next' ? 1 : -1)) || ref;
		} else if (id.act === 'now') {
			ref = await estimate(s, t);
		} else if (id.act === 'play') {
			const r = listenerReader(s, uid);
			const res = playFromHere(s, interaction.user, t, ref, r);
			if (!res.ok) {
				if (r) serial(r, async () => schedule(r, s, t));
				await followUp(interaction, res.text, report);
				return null;
			}
			if (r) {
				await serial(r, async () => {
					await render(r, s, t, ref, 'following');
					r.lastTurnAt = now();
					schedule(r, s, t);
				});
			}
		} else if (id.act === 'dm') {
			const res = await turnOn({ userId: uid });
			await followUp(interaction, res.text, report);
			return null;
		} else {
			return null;
		}
		return answer(interaction, await payloadFor(s, t, ref, { surface: 'e', mode: 'snapshot', viewerId: uid }), report);
	}

	// ---- 📌 sync marks ---------------------------------------------------------------------

	function captureOf(s) {
		return { sid: s.id, pos: books.position(s), state: s.state, audible: !!s.audible, speed: s.speed > 0 ? s.speed : 1 };
	}

	/** The engine's place when a 📌 click arrives, taken before anything is awaited. */
	function capture(sid) {
		const s = books.sessionById(sid);
		return s && s.state !== 'ended' ? captureOf(s) : null;
	}

	// Pages between two pages in reading order, either way round; stops counting past limit.
	async function pagesApart(t, a, b, limit) {
		if (!a || !b || a.kind !== 'page' || b.kind !== 'page') return null;
		const [lo, hi] = a.word <= b.word ? [a, b] : [b, a];
		if (lo.sec === hi.sec) return hi.page - lo.page;
		let n = (await pagesOf(t, lo.sec)).pages.length - lo.page;
		for (const j of t.body) {
			if (j <= lo.sec) continue;
			if (j >= hi.sec) break;
			n += (await pagesOf(t, j)).pages.length;
			if (n > limit) return n;
		}
		return n + hi.page;
	}

	/**
	 * Whether a 📌 on `page` is plausible for a click at `pos` (pinned at `ms`, the click less the
	 * reaction allowance).
	 * @returns {string|null} the refusal note, or null when the page is taken
	 */
	async function nearNarration(t, pos, ms, page) {
		// A chapter-named track's start is exact, so a page outside its chapter is a misclick, however
		// near; as a mark it would beat the next chapter's own track anchors. The click, not the
		// allowance, says which chapter is playing: a pin on a chapter's first page a moment into its
		// track has its ms in the chapter before.
		const playing = model.spanAt(t.map, pos);
		if (playing) return page.word >= playing.fromWord && page.word < playing.toWord ? null : MARK_CHAPTER_TEXT;
		const est = model.msToWord(t.map, ms);
		const loc = model.locate(t.map, est.word);
		if (loc && loc.section === page.sec) return null;
		const n = await pagesApart(t, await pageForWord(t, est.word), page, MARK_NEAR_PAGES);
		return n !== null && n <= MARK_NEAR_PAGES ? null : MARK_FAR_TEXT;
	}

	function sameWork(s, workId) {
		if (s.workId === workId) return true;
		try {
			const cur = catalog().work(s.workId);
			return !!cur && cur.id === workId;
		} catch (_) {
			return false;
		}
	}

	// Every other open page of the recording is handled as if the engine had reported a move: a
	// timed turn never goes back, so a page the new map puts ahead of the voice needs the jump, and
	// the render (the map's revision is in the render key) shows its sync level.
	function refreshWork(workId, except = null) {
		let list = [];
		try { list = books.sessions() || []; } catch (_) {}
		for (const r of readers.values()) {
			if (r === except || r.dead || !r.message) continue;
			const s = list.find(x => x.id === r.sid);
			if (!s || !sameWork(s, workId)) continue;
			serial(r, async () => {
				if (!liveFor(r, s)) return;
				const got = await textFor(s);
				if (got.ok && r.follow && r.shown && s.state === 'playing') await onMove(r, s);
			});
		}
	}

	/** After `!book unmark`: the open pages of that recording pick up the map without the mark. */
	function marksChanged(work) {
		const id = typeof work === 'string' ? work : work && work.id;
		if (!closed && id) refreshWork(id);
	}

	async function markHere(r, s, t, id, cap, interaction, report) {
		const c = cap && cap.sid === s.id ? cap : captureOf(s);
		if (c.state !== 'playing' || !c.audible) return followUp(interaction, MARK_NOT_PLAYING_TEXT, report);
		// The click itself, not the allowance, says whether ebook text was being read: only the
		// allowance may reach back into an intro.
		if (model.inNoText(t.map, c.pos)) return followUp(interaction, MARK_NO_TEXT_TEXT, report);
		const page = await pageForWord(t, id.word);
		const ms = Math.max(0, Math.round(c.pos - MARK_LAG_MS * c.speed));
		if (!page) return followUp(interaction, MARK_FAR_TEXT, report);
		const refused = await nearNarration(t, c.pos, ms, page);
		if (refused) return followUp(interaction, refused, report);
		let res = null;
		try {
			res = store.marks.add(workRef(s), { ms, word: page.word, text: t.base, tag: t.tag, rec: model.recordingOf(s.work), by: r.userId, at: now() }, { nearMs: MARK_REPLACE_MS });
		} catch (err) {
			logger.warn('Read-along could not save a mark:', codeOf(err));
		}
		if (!res || !res.ok) return followUp(interaction, '📌 The mark could not be saved; check the bot log.', report);
		logger.info(`Read-along: mark ${res.mark.id} at ${ms} ms, word ${page.word}${res.replaced.length ? `, replacing ${res.replaced.length}` : ''}.`);
		const got = await textFor(s);
		if (!got.ok) return textGone(r, got);
		r.follow = true;
		r.pin = null;
		clearTurn(r);
		clearCoalesce(r);
		sample(r, s);
		await render(r, s, got.t, page, modeOf(r, s), null, `📌 Marked at ${formatClock(ms, true)}`);
		r.lastTurnAt = now();
		schedule(r, s, got.t);
		refreshWork(s.workId, r);
	}

	async function dmAct(r, s, id, interaction, report, cap = null) {
		// Off needs no text, so a text that can no longer be opened (DRM, Calibre closed) never
		// keeps it from working.
		if (id.act === 'off') {
			try { store.readers.set(r.userId, false); } catch (_) {}
			const msg = r.message;
			drop(r);
			try { await msg.edit(card.offStub({ prefix: prefix() })); } catch (_) {}
			return;
		}
		const got = await textFor(s, { explicit: true });
		if (!got.ok) {
			await followUp(interaction, `📖 ${got.text}`, report);
			return;
		}
		const t = got.t;
		if (id.tag !== t.tag) {
			r.follow = true;
			r.pin = null;
			await jumpNow(r, s, { note: 'text-updated' });
			return;
		}
		if (id.act === 'mark') {
			await markHere(r, s, t, id, cap, interaction, report);
			return;
		}
		const base = (await pageForWord(t, id.word)) || r.shown;
		if (id.act === 'prev' || id.act === 'next') {
			r.follow = false;
			r.pin = null;
			clearTurn(r);
			clearCoalesce(r);
			const from = id.none ? { kind: 'none', word: id.word } : base;
			const ref = (await stepFrom(t, from, id.act === 'next' ? 1 : -1)) || base;
			await render(r, s, t, ref, modeOf(r, s));
			return;
		}
		if (id.act === 'now') {
			r.follow = true;
			r.pin = null;
			clearCoalesce(r);
			await jumpNow(r, s);
			return;
		}
		if (id.act === 'play') {
			const res = playFromHere(s, interaction.user, t, base, r);
			if (!res.ok) {
				schedule(r, s, t);
				await followUp(interaction, res.text, report);
				return;
			}
			await render(r, s, t, base, 'following');
			r.lastTurnAt = now();
			schedule(r, s, t);
		}
	}

	// The DM rules, in order (plan section 9): a click on any page that is not the reader's
	// current one only turns THAT message into "moved"; the reader's own page acts; a stale page
	// is adopted only when the user has no page and a book is playing; anything else is ended.
	async function onDmButton(interaction, id, report, cap = null) {
		const uid = String(interaction.user && interaction.user.id);
		const clicked = interaction.message || null;
		const clickedId = clicked && clicked.id;
		let r = readers.get(uid);
		if (r && r.dead) r = null;
		if (r && r.message && clickedId && r.message.id !== clickedId) return answer(interaction, card.movedStub(), report);
		const s = books.sessionById(id.sid);
		const live = s && s.state !== 'ended' && String(s.userId) === uid ? s : null;
		if (r && r.message && live && r.sid === live.id) {
			await serial(r, () => dmAct(r, live, id, interaction, report, cap));
			return null;
		}
		if (!(r && r.message) && id.act !== 'off') {
			const current = liveSessionOf(uid);
			if (current && clicked && typeof clicked.edit === 'function') {
				if (r) drop(r);
				const nr = newReader(current);
				nr.message = clicked;
				readers.set(uid, nr);
				await serial(nr, () => jumpNow(nr, current));
				return null;
			}
		}
		if (id.act === 'off') {
			try { store.readers.set(uid, false); } catch (_) {}
			return answer(interaction, card.offStub({ prefix: prefix() }), report);
		}
		return answer(interaction, card.endedStub({ bookTitle: s ? titleOf(s) : null }), report);
	}

	/**
	 * A bookpage:* click, already acknowledged with deferUpdate by helpers/readAlongButtons.js.
	 * @param {object} id the parsed customId (readAlongCard.parsePageId)
	 * @param {{ report?: Function, captured?: object }} [o] report is called with every payload sent,
	 *   for the command log; captured is capture(sid) taken as a 📌 click arrived
	 */
	async function onPageButton(interaction, id, { report = () => {}, captured = null } = {}) {
		if (closed) return answer(interaction, card.noticePayload('Read-along is restarting; try again in a moment.'), report);
		if (id.surface === 'e') return onEphemeralButton(interaction, id, report);
		return onDmButton(interaction, id, report, id.act === 'mark' ? captured || capture(id.sid) : null);
	}

	// ---- wiring ----------------------------------------------------------------------------

	function onSourceChange(workId) {
		if (closed) return;
		let list = [];
		try { list = books.sessions() || []; } catch (_) {}
		// The source names the catalog's current id; a session keeps the old one after a rebuild
		// renamed its work until the engine's next save follows the rename.
		const same = (s) => {
			if (s.workId === workId) return true;
			try {
				const cur = catalog().work(s.workId);
				return !!cur && cur.id === workId;
			} catch (_) {
				return false;
			}
		};
		for (const s of list) if (same(s)) refreshCardIfChanged(s);
		for (const r of readers.values()) {
			const s = list.find(x => x.id === r.sid);
			if (!s || !same(s) || !r.message || !r.shownTag) continue;
			serial(r, async () => {
				if (!liveFor(r, s)) return;
				const got = await textFor(s);
				if (!got.ok) textGone(r, got);
				else if (got.t.tag !== r.shownTag) requestJump(r, s, 'text-updated');
			});
		}
	}

	const unsubscribeBooks = books.onChange(onEngine);
	books.setTextInfo(cardInfo);
	const unsubscribeSource = typeof source.onChange === 'function' ? source.onChange(onSourceChange) : () => {};

	/**
	 * Timers stopped and hooks removed. Run after the director's shutdown, which queues each open
	 * page's stub edit; on a signal shutdown the process exits before those edits are sent.
	 */
	function shutdown() {
		closed = true;
		for (const r of readers.values()) {
			clearTurn(r);
			clearCoalesce(r);
		}
		try { if (typeof unsubscribeBooks === 'function') unsubscribeBooks(); } catch (_) {}
		try { books.setTextInfo(null); } catch (_) {}
		try { unsubscribeSource(); } catch (_) {}
		try { source.shutdown(); } catch (_) {}
	}

	return {
		turnOn,
		turnOff,
		sendNow,
		status,
		cardInfo,
		statusOf,
		ephemeralFor,
		onPageButton,
		capture,
		marksChanged,
		dm: sendDm,
		source,
		shutdown,
		_reader: uid => readers.get(String(uid)) || null
	};
}

module.exports = {
	createReadAlong,
	readerAccess,
	joinToReadText,
	PAGE_TARGET_WORDS,
	PAGE_MAX_CHARS,
	MIN_TURN_GAP_MS,
	JUMP_PAGES,
	EDIT_COALESCE_MS,
	TURN_PAD_MS,
	MAX_TIMER_MS
};
