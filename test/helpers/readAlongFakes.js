// test/helpers/readAlongFakes.js
//
// Fakes for the read-along tests (readAlong, readAlongButtons, readAlongPictures,
// bookTextCommand): a manual clock whose advance() runs each due timer and then lets the pager's
// promise chains settle, a book director that plays a session by the clock (position = anchor +
// elapsed x speed) and notifies like bookEngine does, a text source serving a synthetic ebook from
// memory, a picture source standing in for helpers/bookPictures.js, and a Discord client whose
// DM sends and edits are recorded.
//
// Every word comes from test/helpers/epubFixture.js (the NATO alphabet), so no copyrighted text.
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const model = require('../../helpers/readAlongModel.js');
const card = require('../../helpers/readAlongCard.js');
const { words: fixtureWords } = require('./epubFixture.js');

const T0 = 1791500000000;
// 180 words a minute: one word every 333.33 ms of narration.
const MS_PER_WORD = 1000 / 3;

async function flush(n = 4) {
	for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

function manualClock(start = T0) {
	let t = start;
	let seq = 0;
	const due = new Map();
	return {
		setTimeout(fn, ms) {
			const h = { id: ++seq, at: t + Math.max(0, ms || 0), fn, unref() {} };
			due.set(h.id, h);
			return h;
		},
		clearTimeout(h) { if (h) due.delete(h.id); },
		now: () => t,
		pending: () => due.size,
		async advance(ms, { onStep } = {}) {
			const end = t + ms;
			for (;;) {
				let next = null;
				for (const d of due.values()) {
					if (d.at <= end && (!next || d.at < next.at || (d.at === next.at && d.id < next.id))) next = d;
				}
				if (!next) break;
				due.delete(next.id);
				t = Math.max(t, next.at);
				if (onStep) await onStep(t);
				next.fn();
				await flush();
			}
			t = end;
			if (onStep) await onStep(t);
			await flush();
		}
	};
}

/**
 * A synthetic ebook as the cache would hold it: sections of `words` words in paragraphs of
 * `para` words, joined by \n like helpers/epubText.js writes them.
 * @param {Array<{ label: string, words: number, para?: number }>} sections
 * @param {{ paths?: string }} [opts] paths: a directory to write the cache pair into
 *   (`<base>.txt`, `<base>.json`, real byte offsets); only then does the handle carry textPath and
 *   indexPath, as bookTextSource's does (the real helpers/bookPictures.js gives a handle without
 *   them no pictures)
 */
function makeText(sections, { base = 'a1b2c3d4e5f60718', start = 0, label = 'Calibre #1', paths = null } = {}) {
	const texts = [];
	const index = { version: 1, builtAt: T0 - 86400000, totalWords: 0, sections: [] };
	let wordStart = 0;
	let byteStart = 0;
	sections.forEach((sec, i) => {
		const paras = [];
		let left = sec.words;
		let k = 0;
		while (left > 0) {
			const n = Math.min(left, sec.para || 60);
			paras.push(fixtureWords(n, start + wordStart + k));
			left -= n;
			k += n;
		}
		const text = paras.join('\n');
		texts.push(text);
		const byteLen = Buffer.byteLength(text);
		index.sections.push({ label: sec.label, href: `text/c${i}.xhtml`, depth: 1, part: 0, words: model.words(text).length, wordStart, byteStart: paths ? byteStart : 0, byteLen, paragraphs: paras.length });
		wordStart += sec.words;
		byteStart += byteLen + 1;
	});
	index.totalWords = wordStart;
	const reads = [];
	const handle = {
		workId: null,
		base,
		tag: base.slice(0, 4),
		fingerprint: `fake:${base}`,
		index,
		source: { type: 'calibre', id: 1 },
		via: 'auto',
		label,
		async readSection(i) {
			reads.push(i);
			return texts[i] || '';
		}
	};
	if (paths) {
		const body = `${texts.join('\n')}\n`;
		Object.assign(index, { textFile: `${base}.txt`, textBytes: Buffer.byteLength(body) });
		handle.textPath = pathMod.join(paths, `${base}.txt`);
		handle.indexPath = pathMod.join(paths, `${base}.json`);
		fs.mkdirSync(paths, { recursive: true });
		fs.writeFileSync(handle.textPath, body);
		fs.writeFileSync(handle.indexPath, JSON.stringify(index));
	}
	return { index, texts, handle, reads };
}

/** A work whose parts are named after the sections, each as long as its words take to read. */
function makeWork(sections, { id = 'test-author/the-fake-book', title = 'The Fake Book', kind = 'book', parts = null } = {}) {
	return {
		id,
		kind,
		title,
		author: 'Test Author',
		narrator: null,
		edition: null,
		publisher: null,
		aliases: [],
		parts: parts || sections.map((s, i) => ({ ordinal: i + 1, title: s.label, durationMs: Math.round(s.words * MS_PER_WORD), partKey: `/p/${i}`, file: `p${i}.mp3` }))
	};
}

/** Every page of every body section, in reading order: [{ sec, page, word, endWord }]. */
function expectedPages(work, text) {
	const map = model.buildMap(work, text.index);
	const out = [];
	map.sections.forEach((sec, i) => {
		if (sec.matter !== 'body' || !(sec.words > 0)) return;
		const pages = model.paginate(text.texts[i], { targetWords: 180, maxChars: 1400 });
		pages.forEach((p, k) => out.push({ sec: i, page: k, word: sec.wordStart + p.startWord, endWord: sec.wordStart + p.endWord }));
	});
	return { map, pages: out };
}

function fakeSource(text, { status = 'ready', openResult = null } = {}) {
	const listeners = new Set();
	const src = {
		calls: [],
		statusValue: status,
		probeValue: status,
		openResult,
		text,
		status(work) { src.calls.push(['status', work && work.id]); return src.statusValue; },
		async probe(work) { src.calls.push(['probe', work && work.id]); src.statusValue = src.probeValue; return src.probeValue; },
		async open(work, opts = {}) {
			src.calls.push(['open', work && work.id, !!opts.explicit]);
			// A first download and parse in flight: open() waits until the test releases it.
			if (src.hold) await src.hold;
			if (src.openResult) return src.openResult;
			src.statusValue = 'ready';
			return { ok: true, handle: src.text.handle, stale: false };
		},
		async link(work, target, opts) { src.calls.push(['link', work && work.id, target, opts]); return { ok: true, code: 'linked', text: `Linked ${work.title} to Calibre #${target.id || '?'} “Fake” (EPUB).` }; },
		async describe(work, { paths = false } = {}) {
			src.calls.push(['describe', work && work.id, paths]);
			const file = paths ? 'D:/Media/Books/Fake Book/The Fake Book.epub' : 'The Fake Book.epub';
			return {
				workId: work.id, title: work.title, status: src.statusValue,
				link: null,
				cache: { via: 'sidecar', label: 'EPUB next to the audio', source: { type: 'file', path: file, size: 1000 }, valid: true, failed: null, totalWords: 1800, sections: 2, builtAt: T0, at: T0 },
				candidates: { calibre: [{ id: 7, title: 'The Fake Book', authors: ['Test Author'], series: null, seriesIndex: null, epub: true, accepted: true, titleScore: 1 }], sidecars: [{ file, size: 1000, score: 1, accepted: true }], calibreError: null },
				lastError: null
			};
		},
		onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		emit(workId) { for (const fn of listeners) fn(workId); },
		shutdown() { src.calls.push(['shutdown']); }
	};
	return src;
}

function fakeBooks(clock) {
	const listeners = new Set();
	const sessions = [];
	const books = {
		calls: [],
		refreshes: [],
		textInfo: null,
		forbid: null,
		gotoOffsetMs: 0,
		onMoved: null,
		sessions: () => sessions.filter(s => s.state !== 'ended'),
		sessionById: id => sessions.find(s => s.id === id && s.state !== 'ended') || null,
		position(s) {
			if (s.state === 'playing' && s.audible) return s._anchor + (clock.now() - s._at) * s.speed;
			return s._anchor;
		},
		setPos(s, ms) { s._anchor = ms; s._at = clock.now(); },
		emit(s, kind) { for (const fn of listeners) fn(s, kind); },
		onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		listenerCount: () => listeners.size,
		setTextInfo(fn) { books.textInfo = fn; },
		refreshCard(s) {
			books.refreshes.push(s.id);
			// The engine re-renders the card, which reads the text info again.
			if (books.textInfo) books.textInfo(s);
		},
		controlSession(s, user, action, arg) {
			books.calls.push([action, arg, user && user.id]);
			if (books.forbid || String(user && user.id) !== String(s.userId)) {
				return { ok: false, code: 'forbidden', text: books.forbid || `This is ${s.listenerName}'s book: only they can control it.` };
			}
			if (action === 'resume') {
				if (s.state !== 'paused') return { ok: true, code: 'noop', text: 'Already playing.' };
				const at = Math.max(0, s._anchor - 5000);
				s.state = 'playing';
				books.setPos(s, at);
				books.emit(s, 'moved');
				return { ok: true, code: 'ok', text: '▶ Resuming' };
			}
			if (action === 'goto') {
				books.setPos(s, arg.ms + books.gotoOffsetMs);
				books.emit(s, 'moved');
				return { ok: true, code: 'ok', text: '↪' };
			}
			return { ok: true, code: 'ok', text: action };
		},
		add(over = {}) {
			const s = Object.assign({
				id: 'a1b2c3',
				guildId: 'g1',
				userId: 'u1',
				listenerName: 'Ana',
				voiceChannelId: 'v1',
				voiceChannelName: 'Lounge',
				state: 'playing',
				speed: 1,
				audible: true,
				textChannel: fakeChannel()
			}, over);
			s.workId = s.work.id;
			s._anchor = over.atMs || 0;
			s._at = clock.now();
			sessions.push(s);
			return s;
		},
		pause(s) {
			s._anchor = books.position(s);
			s._at = clock.now();
			s.state = 'paused';
			books.emit(s, 'paused');
		},
		end(s) {
			s.state = 'ended';
			books.emit(s, 'ended');
		}
	};
	return books;
}

function fakeChannel(id = 't1') {
	const ch = {
		id,
		sent: [],
		async send(p) { ch.sent.push(p); return { id: `c${ch.sent.length}`, payload: p }; }
	};
	return ch;
}

function discordError(code) {
	return Object.assign(new Error(`Discord error ${code}`), { code });
}

// A failure set on the fake client or a message: a Discord code, or a function of the payload
// that returns a code, an Error, or nothing for a send that goes through.
function failureFor(spec, payload) {
	const f = typeof spec === 'function' ? spec(payload) : spec;
	if (!f) return null;
	return f instanceof Error ? f : discordError(f);
}

/**
 * Stands in for helpers/bookPictures.js as createReadAlong takes it (opts.pictures): the
 * instance's forText, ensure, status, describe, command, onChange and shutdown, plus the pure
 * between and statusLine. A test puts pictures on a work with set(workId, [picture(page, word)]),
 * turns the owner's setting with `setting`, and emits a change as the real one does. Nothing is
 * read or written: a picture's path names a file that does not exist.
 */
function fakePictures({ dir = pathMod.join(os.tmpdir(), 'plexbot-fake-pictures', '0123456789abcdef') } = {}) {
	const listeners = new Set();
	const sets = new Map();
	const order = (a, b) => a.word - b.word || a.pages[0] - b.pages[0];
	const p = {
		calls: [],
		setting: true,
		statusValue: null,
		describeValue: null,
		commandResult: { ok: true, code: 'redo', text: '🖼 Reading Calibre #1\'s PDF for pictures again; it takes a few minutes.' },
		dir,
		/**
		 * One picture as a set holds it: printed page n (n and n + 1 for a spread) at a global word.
		 * `fallback`, when given, is the word it takes where the narration never reaches its own.
		 */
		picture(page, word, { spread = false, kind = null, bytes = 150000, fallback = null } = {}) {
			const pad = n => String(n).padStart(3, '0');
			const id = spread ? `p${pad(page)}-${pad(page + 1)}` : `p${pad(page)}`;
			const pic = {
				id, word, path: pathMod.join(dir, `${id}.jpg`), name: `${id}.jpg`, pages: spread ? [page, page + 1] : [page],
				kind: kind || (spread ? 'spread' : 'part'), width: spread ? 1956 : 978, height: 1200, bytes,
				alt: `Picture from the printed book, page ${page}`
			};
			if (fallback !== null) pic.fallback = fallback;
			return pic;
		},
		set(workId, pictures) { sets.set(workId, pictures); },
		forText(work, handle) {
			const list = p.setting && work ? sets.get(work.id) : null;
			if (!list) return null;
			return { key: pathMod.basename(dir), base: handle ? handle.base : null, workId: work.id, pdfId: 1, count: list.length, pictures: list.slice().sort(order) };
		},
		ensure(work, handle) { p.calls.push(['ensure', work && work.id, handle]); },
		status(work, handle) { p.calls.push(['status', work && work.id, handle]); return p.statusValue; },
		async describe(work) { p.calls.push(['describe', work && work.id]); return p.describeValue; },
		async command(work, action, opts) { p.calls.push(['command', work && work.id, action, opts]); return p.commandResult; },
		onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		listenerCount: () => listeners.size,
		emit(workId) { for (const fn of [...listeners]) fn(workId); },
		shutdown() { p.calls.push(['shutdown']); },
		between(pictures, fromWord, toWord, max = 10) {
			const hits = pictures.filter(x => x.word >= fromWord && x.word < toWord).sort(order);
			return { shown: hits.slice(0, max), count: hits.length };
		},
		statusLine(st, { prefix = '!' } = {}) {
			return st ? `🖼 ${st.state}${Number.isFinite(st.count) ? `: ${st.count} pictures` : ''} (${prefix}book link)` : null;
		},
		callsOf: kind => p.calls.filter(c => c[0] === kind)
	};
	return p;
}

function fakeClient() {
	const c = { dmFail: null, sent: [], messages: [], seq: 0 };
	const makeMsg = (payload, uid) => {
		const m = {
			id: `m${++c.seq}`,
			userId: uid,
			payload,
			first: payload,
			edits: [],
			editFail: null,
			async edit(p) {
				const err = failureFor(m.editFail, p);
				if (err) throw err;
				m.edits.push(p);
				m.payload = p;
				return m;
			}
		};
		c.messages.push(m);
		return m;
	};
	c.users = {
		async fetch(uid) {
			return {
				id: uid,
				async createDM() {
					return {
						async send(p) {
							const err = failureFor(c.dmFail, p);
							if (err) throw err;
							const m = makeMsg(p, uid);
							c.sent.push(m);
							return m;
						}
					};
				}
			};
		}
	};
	c.makeMsg = makeMsg;
	return c;
}

/** The global start word of each page payload in a message's history (null for stubs). */
function wordsOf(msg) {
	return [msg.first, ...msg.edits].map(pageWordOf);
}

function pageWordOf(payload) {
	const row = payload && payload.components && payload.components[0];
	const b = row && row.components && row.components[0];
	const id = b && card.parsePageId(b.custom_id);
	return id ? id.word : null;
}

function textOf(payload) {
	const e = payload && payload.embeds && payload.embeds[0];
	return [payload && payload.content, e && e.title, e && e.description, e && e.footer && e.footer.text].filter(Boolean).join('\n');
}

/**
 * A guild whose voice-state cache the test moves people through, as the gateway would:
 * g.join('u2', 'v1'), g.leave('u2').
 */
function fakeGuild(id = 'g1') {
	const cache = new Map();
	return {
		id,
		voiceStates: { cache },
		join(uid, channelId) { cache.set(String(uid), { id: String(uid), channelId }); },
		leave(uid) { cache.set(String(uid), { id: String(uid), channelId: null }); }
	};
}

/**
 * A recording ButtonInteraction (after deferUpdate/deferReply, as the router leaves it).
 * `voice` is the member's own voice state, for a member object the guild cache disagrees with.
 */
function fakeInteraction({ customId = '', user = { id: 'u1', username: 'Ana' }, message = null, guild = null, voice = null } = {}) {
	const calls = [];
	return {
		calls,
		customId,
		user,
		member: guild ? Object.assign({ id: user.id, user }, voice ? { voice } : {}) : null,
		guild,
		guildId: guild ? guild.id : null,
		message,
		async deferUpdate() { calls.push(['deferUpdate']); },
		async deferReply(p) { calls.push(['deferReply', p]); },
		async editReply(p) { calls.push(['editReply', p]); },
		async followUp(p) { calls.push(['followUp', p]); },
		async reply(p) { calls.push(['reply', p]); },
		async update(p) { calls.push(['update', p]); }
	};
}

module.exports = {
	T0,
	MS_PER_WORD,
	flush,
	manualClock,
	makeText,
	makeWork,
	expectedPages,
	fakeSource,
	fakePictures,
	fakeBooks,
	fakeChannel,
	fakeClient,
	fakeGuild,
	discordError,
	wordsOf,
	pageWordOf,
	textOf,
	fakeInteraction
};
