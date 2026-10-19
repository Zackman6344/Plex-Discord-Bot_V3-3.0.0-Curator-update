// helpers/bookTags.js
//
// Embedded tags of audiobook files, for the catalog. A GraphicAudio file names its publisher as
// the artist and its author only in the copyright tag, and genres tell a 3-hour mix from a book,
// none of which Plex's listing carries. Most files are read as their album's sample; a folder that
// may hold loose single-file books has each file read for itself, keyed by its track.
//
// Read with ffmpeg-static in a child process (`ffmpeg -i file` prints the container metadata and
// exits), two at a time, each child at Below Normal priority: CPU contention is a measured cause
// of voice stutter, and the event loop never waits on a read. Results are cached by path, size and
// mtime in data/book_tags.json, so only new or changed files cost a spawn. A file ffmpeg itself
// cannot open (a path too long for it, a damaged file) is cached as failed for that size and mtime,
// so every build does not spawn for it again; it is retried when the file changes or after 30 days.
// Only a short whitelist of factual tags is kept; descriptions, lyrics and synopses are never stored,
// and of the comment tag only its credit lines are.

const path = require('path');
const { createStore } = require('./jsonStore.js');

const DAY = 24 * 60 * 60 * 1000;
const KEEP_TAGS = Object.freeze(['album', 'album_artist', 'artist', 'composer', 'genre', 'copyright', 'comment', 'narrator', 'publisher', 'title', 'track', 'date', 'asin', 'audible_asin']);
const KEEP = new Set(KEEP_TAGS);
const MAX_VALUE = 300;
const SPAWN_TIMEOUT_MS = 20000;
const MAX_BUFFER = 4 * 1024 * 1024;
const PRUNE_AFTER_MS = 30 * DAY;
const RETRY_FAILED_AFTER_MS = 30 * DAY;
// A hit refreshes its last-seen time at most daily, so a warm build does not rewrite the file.
const SEEN_REFRESH_MS = DAY;

/**
 * The container metadata of ffmpeg's `-i` banner (stderr): the `Input #0` block's `Metadata:`
 * lines, with continuation lines joined, plus the number of chapters.
 * @returns {{ tags: Object<string, string>, chapters: number }}
 */
function parseProbe(text) {
	const tags = {};
	let state = 'pre';
	let lastKey = null;
	let chapters = 0;
	for (const line of String(text || '').split(/\r?\n/)) {
		if (/^Input #0/.test(line)) { state = 'input'; continue; }
		if (state === 'input' && /^\s{2}Metadata:/.test(line)) { state = 'meta'; continue; }
		if (/^\s{2}Duration:/.test(line) && (state === 'meta' || state === 'input')) state = 'after';
		if (/^\s{4}Chapter #/.test(line)) chapters++;
		if (state !== 'meta') continue;
		const m = line.match(/^\s{4}(\S[^:]*?)\s*:\s?(.*)$/);
		if (m && m[1].trim() !== '') {
			lastKey = m[1].trim().toLowerCase();
			if (KEEP.has(lastKey) && !Object.prototype.hasOwnProperty.call(tags, lastKey)) tags[lastKey] = m[2].slice(0, MAX_VALUE);
			continue;
		}
		const c = line.match(/^\s{6,}:\s?(.*)$/);
		if (c && lastKey && KEEP.has(lastKey) && Object.prototype.hasOwnProperty.call(tags, lastKey)) {
			tags[lastKey] = `${tags[lastKey]}\n${c[1]}`.slice(0, MAX_VALUE);
		}
	}
	if (Object.prototype.hasOwnProperty.call(tags, 'comment')) {
		const credits = creditLines(tags.comment);
		if (credits) tags.comment = credits;
		else delete tags.comment;
	}
	return { tags, chapters };
}

// A ripped audiobook's comment is usually the publisher's summary, copyrighted and of no use
// here. Only what bookCatalog reads from it is kept: who wrote or reads the book, and
// GraphicAudio's web address, each from where it starts and cut short.
const CREDIT_RE = /written\s+by|^\s*by\s*:|(?:narrated|read)\s+by|graphicaudio\.net/i;
const CREDIT_MAX = 120;

function creditLines(text) {
	return String(text || '').split('\n')
		.map((line) => {
			const m = CREDIT_RE.exec(line);
			return m ? line.slice(m.index).trim().slice(0, CREDIT_MAX) : '';
		})
		.filter(Boolean)
		.join('\n');
}

function cacheKey(file, st) {
	return `${String(file).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`;
}

function fileOfKey(key) {
	const parts = String(key).split('|');
	return parts.slice(0, -2).join('|');
}

function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

// A failed entry has no tags; it only says not to spawn for this size and mtime again yet.
function good(entry) {
	return isObject(entry) && !entry.failed && isObject(entry.tags);
}

function present(v) {
	return v !== undefined && v !== null;
}

// An album sample names its album and track; a file read for itself names only its track.
function validJob(j) {
	return isObject(j) && (present(j.album) || present(j.track)) && typeof j.file === 'string' && j.file !== '';
}

function put(out, j, value) {
	if (present(j.album)) out.byAlbum[String(j.album)] = value;
	if (present(j.track)) out.byTrack[String(j.track)] = value;
}

function view(entry) {
	return { tags: { ...entry.tags }, chapters: entry.chapters || 0, at: entry.at || 0 };
}

function defaultStore() {
	return createStore({
		envVar: 'PLEXBOT_BOOK_TAGS_FILE',
		defaultPath: path.join(__dirname, '..', 'data', 'book_tags.json'),
		key: 'tags',
		shape: 'object',
		label: 'tag cache',
		feature: 'Audiobook',
		pretty: false,
		// Keyed by file paths, which nothing here controls.
		nullPrototype: true,
	});
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.execFile] child_process.execFile
 * @param {(file: string) => Promise<{size: number, mtimeMs: number}>} [deps.stat]
 * @param {string} [deps.ffmpegPath] ffmpeg-static by default, resolved on first read
 * @param {object} [deps.store] a jsonStore-shaped cache
 * @param {{ setPriority: Function, constants: object }} [deps.os]
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 * @param {number} [deps.maxSpawns] ffmpeg children alive at once across all reads (2)
 */
function createTags(deps = {}) {
	const execFile = deps.execFile || ((...args) => require('child_process').execFile(...args));
	const stat = deps.stat || ((file) => require('fs').promises.stat(file));
	const osMod = deps.os || require('os');
	const now = deps.now || Date.now;
	const loggerOf = () => deps.logger || require('./logger.js');
	let storeRef = deps.store || null;
	const store = () => storeRef || (storeRef = defaultStore());
	const inflight = new Map();
	// Across every read, not per read: a rescan that starts while an earlier read's leftovers are
	// still running must not double the number of ffmpeg children.
	const maxSpawns = Math.max(1, Number(deps.maxSpawns) || 2);
	let spawning = 0;
	const waiting = [];
	let priorityWarned = false;
	let dirty = false;

	async function withSpawnSlot(fn) {
		if (spawning >= maxSpawns) await new Promise((resolve) => waiting.push(resolve));
		spawning++;
		try {
			return await fn();
		} finally {
			spawning--;
			const wake = waiting.shift();
			if (wake) wake();
		}
	}

	function data() {
		return store().load();
	}

	function lowerPriority(child) {
		if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
		try {
			osMod.setPriority(child.pid, osMod.constants.priority.PRIORITY_BELOW_NORMAL);
		} catch (err) {
			if (!priorityWarned) {
				priorityWarned = true;
				loggerOf().warn(`Could not lower the audiobook tag reader's priority (${(err && err.code) || 'error'}); it runs at Normal.`);
			}
		}
	}

	// Resolves with the parsed banner, 'unreadable' when ffmpeg ran and could not open the file, or
	// null when the read itself went wrong (spawn error, timeout, too much output), which may pass.
	function probe(file) {
		return new Promise((resolve) => {
			let child;
			try {
				const ffmpeg = deps.ffmpegPath || require('ffmpeg-static');
				// ffmpeg always exits non-zero here (no output file is named), so success is whether
				// it got as far as describing the input.
				child = execFile(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true, timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
					const text = String(stderr || '');
					if (/^Input #0/m.test(text) && !(err && (err.killed || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))) return resolve(parseProbe(text));
					const ranAndFailed = !err || (typeof err.code === 'number' && !err.killed && !err.signal);
					resolve(ranAndFailed ? 'unreadable' : null);
				});
			} catch (_) {
				resolve(null);
				return;
			}
			lowerPriority(child);
		});
	}

	// The newest entry for this file at any size or mtime: a file that cannot be read this time
	// (an unmounted drive, a hung read) keeps what it said last time.
	function lastGood(file) {
		const want = String(file).toLowerCase();
		let best = null;
		const d = data();
		for (const k of Object.keys(d)) {
			if (fileOfKey(k) !== want || !good(d[k])) continue;
			if (!best || (d[k].at || 0) > (best.at || 0)) best = d[k];
		}
		return best;
	}

	function touch(entry) {
		if (now() - (entry.seen || 0) >= SEEN_REFRESH_MS) {
			entry.seen = now();
			dirty = true;
		}
	}

	function flush() {
		if (!dirty) return;
		const d = data();
		const cutoff = now() - PRUNE_AFTER_MS;
		for (const k of Object.keys(d)) {
			const e = d[k];
			if (!isObject(e) || (e.seen || e.at || 0) < cutoff) delete d[k];
		}
		dirty = false;
		store().persist();
	}

	/**
	 * Reads the tags of each sampled file, from the cache when its size and mtime still match.
	 * Resolves when every job is done or budgetMs has passed, whichever is first; reads still
	 * running then finish in the background and land in the cache. Never throws.
	 * @param {Array<{ album?: string, track?: string, file: string, sizeBytes?: number }>} list
	 *   each job names an album, a track or both
	 * @param {{ budgetMs?: number, concurrency?: number, signal?: AbortSignal }} [opts]
	 * @returns {Promise<{ byAlbum: Object<string, {tags: object, chapters: number, at: number}>,
	 *   byTrack: Object<string, {tags: object, chapters: number, at: number}>,
	 *   pending: number, failed: number, settled: Promise<{ added: number }> }>} pending: jobs
	 *   unfinished when it resolved; settled: resolves once they are all done, with how many
	 *   new entries they added
	 */
	async function read(list, { budgetMs = 45000, concurrency = 2, signal } = {}) {
		try {
			const jobs = (Array.isArray(list) ? list : []).filter(validJob);
			const out = { byAlbum: {}, byTrack: {} };
			let done = 0;
			let failed = 0;
			let added = 0;
			let next = 0;
			const stopped = () => !!(signal && signal.aborted);

			const fallback = (j) => {
				failed++;
				const old = lastGood(j.file);
				if (old) put(out, j, view(old));
			};
			const runJob = async (j) => {
				let st;
				try {
					st = await stat(j.file);
				} catch (_) {
					fallback(j);
					return;
				}
				const k = cacheKey(j.file, st);
				const hit = data()[k];
				if (isObject(hit) && hit.failed && now() - (hit.at || 0) < RETRY_FAILED_AFTER_MS) {
					fallback(j);
					return;
				}
				if (good(hit)) {
					touch(hit);
					put(out, j, view(hit));
					return;
				}
				let p = inflight.get(k);
				if (!p) {
					p = withSpawnSlot(() => probe(j.file)).then((r) => {
						if (r === 'unreadable') {
							data()[k] = { failed: true, at: now(), seen: now() };
							dirty = true;
							return null;
						}
						if (r) {
							data()[k] = { tags: r.tags, chapters: r.chapters, at: now(), seen: now() };
							dirty = true;
							added++;
						}
						return r;
					}).finally(() => inflight.delete(k));
					inflight.set(k, p);
				}
				const r = await p;
				const entry = data()[k];
				if (r && good(entry)) put(out, j, view(entry));
				else fallback(j);
			};
			const worker = async () => {
				while (next < jobs.length && !stopped()) {
					const j = jobs[next++];
					try {
						await runJob(j);
					} catch (_) {
						failed++;
					}
					done++;
				}
			};
			const n = Math.max(1, Math.min(Number(concurrency) || 1, jobs.length || 1));
			const all = Promise.all(Array.from({ length: n }, worker));
			const settled = all.then(() => {
				try { flush(); } catch (_) {}
				return { added };
			}, () => ({ added }));

			let timer = null;
			let onAbort = null;
			const budget = new Promise((resolve) => {
				timer = setTimeout(resolve, Math.max(0, Number(budgetMs) || 0));
				if (timer && typeof timer.unref === 'function') timer.unref();
				if (signal) {
					onAbort = resolve;
					if (signal.aborted) resolve();
					else signal.addEventListener('abort', onAbort, { once: true });
				}
			});
			await Promise.race([settled, budget]);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener('abort', onAbort);
			return { byAlbum: { ...out.byAlbum }, byTrack: { ...out.byTrack }, pending: jobs.length - done, failed, settled };
		} catch (_) {
			return { byAlbum: {}, byTrack: {}, pending: 0, failed: 0, settled: Promise.resolve({ added: 0 }) };
		}
	}

	/**
	 * What the cache already holds, without a stat or a spawn: matched by path and Plex's size,
	 * newest first. Never throws.
	 * @returns {{ byAlbum: Object<string, {tags: object, chapters: number, at: number}>,
	 *   byTrack: Object<string, {tags: object, chapters: number, at: number}> }}
	 */
	function cached(list) {
		const out = { byAlbum: {}, byTrack: {} };
		try {
			const d = data();
			const keys = Object.keys(d);
			for (const j of (Array.isArray(list) ? list : []).filter(validJob)) {
				const want = String(j.file).toLowerCase();
				let best = null;
				for (const k of keys) {
					if (fileOfKey(k) !== want || !good(d[k])) continue;
					if (j.sizeBytes && k.split('|').slice(-2)[0] !== String(j.sizeBytes)) continue;
					if (!best || (d[k].at || 0) > (best.at || 0)) best = d[k];
				}
				if (best) put(out, j, view(best));
			}
		} catch (_) {}
		return out;
	}

	return { read, cached, reset: () => { if (storeRef && storeRef.reset) storeRef.reset(); dirty = false; inflight.clear(); } };
}

const tags = createTags();

module.exports = { ...tags, createTags, parseProbe, cacheKey, KEEP_TAGS, MAX_VALUE };
