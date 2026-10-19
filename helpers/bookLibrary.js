// helpers/bookLibrary.js
//
// The Plex side of the catalog: list the music sections, build, probe chapters, notice when the
// library changed, and find a part's key again after a re-scan killed it.
//
// A full listing costs about 17 s and 25 MB on a large library, so it runs only when something
// says the library changed: no catalog yet, a section's scannedAt, updatedAt or track count moved,
// the build is a day old, or the rules changed. The cheap check behind that runs hourly while
// audiobooks are enabled, so a book added while the bot runs for days stays out of music within
// the hour, and at most hourly from /book play.
//
// Never /search: a title search picks among duplicates (the same artist and title exist many
// times over across narrations and re-rips), and a key repaired to the wrong file plays the
// wrong book. Repair goes through the track's own ratingKey and checks the file basename.
//
// A build waits for embedded tags (helpers/bookTags.js) up to TAG_BUDGET_MS. Without them a
// GraphicAudio book has no author and comes out as "untitled/<title>", to be renamed on the next
// build; warm builds read from the cache in milliseconds, so only the first build of a large
// library, about 30 s, ever waits for long. Folders that may hold loose single-file books have
// every file read, about 0.3 s each, so the first build after rules version 4 also waits. Reads
// still running when the budget ends finish in the background and trigger one more build.
//
// Displayed metadata goes through helpers/bookMetadata.js before the catalog is replaced, so a
// build shows the owner's edits, Calibre's and the online lookup's fills at once instead of the
// raw detection until the next refresh. With the online lookup on, every build queues a lookup
// batch afterwards; it is never awaited here (21 books take up to half a minute at one request a
// second), and its fills reach the catalog through refreshMetadata() when it finishes.

const logger = require('./logger.js');
const bookCatalog = require('./bookCatalog.js');

const HOUR = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = HOUR;
const PLAY_CHECK_MIN_GAP_MS = HOUR;
const MAX_CATALOG_AGE_MS = 24 * HOUR;
const REPAIR_REBUILD_MIN_GAP_MS = 10 * 60 * 1000;
const TAG_BUDGET_MS = 45 * 1000;
const TAG_CONCURRENCY = 2;
const TAG_REBUILD_MIN_GAP_MS = 10 * 60 * 1000;

function metadataOf(res) {
	return (res && res.MediaContainer && Array.isArray(res.MediaContainer.Metadata)) ? res.MediaContainer.Metadata : [];
}

function redact(text) {
	return String(text || '').replace(/(X-Plex-Token[=:]\s*)[^&\s]+/gi, '$1REDACTED');
}

function messageOf(err) {
	return redact(err && err.message ? err.message : err);
}

/** The folders of the music sections, which the catalog never treats as a book's folder. */
function rootsOf(sections) {
	const out = [];
	for (const s of sections || []) {
		for (const loc of Array.isArray(s && s.Location) ? s.Location : []) {
			if (loc && typeof loc.path === 'string' && loc.path && !out.includes(loc.path)) out.push(loc.path);
		}
	}
	return out;
}

/**
 * @param {object} [deps]
 * @param {(path: string) => Promise<any>} [deps.query] a Plex GET; the shared client by default,
 *   created on first use so requiring this module never reads config/plex.js
 * @param {object} [deps.store] the catalog store
 * @param {() => object} [deps.getConfig] read at call time, so enabling the feature live works
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setInterval]
 * @param {Function} [deps.clearInterval]
 * @param {{ read: Function }} [deps.tags] the embedded tag reader (helpers/bookTags.js)
 * @param {Function} [deps.setTimeout] for a tag rebuild that has to wait out its rate limit
 * @param {Function} [deps.clearTimeout]
 * @param {{ refresh: Function }} [deps.lookup] the online lookup (bookLookup.instance())
 * @param {{ resolveWith: Function, overrideFor: Function }} [deps.metadata] helpers/bookMetadata.js
 */
function createLibrary(deps = {}) {
	const query = deps.query || ((p) => require('./plexClient.js').getPlex().query(p));
	const store = deps.store || require('./bookCatalogStore.js');
	const getConfig = deps.getConfig || (() => require('../config/config.js'));
	const tagReader = () => deps.tags || require('./bookTags.js');
	const lookupOf = () => deps.lookup || require('./bookLookup.js').instance();
	const metadataLayer = () => deps.metadata || require('./bookMetadata.js');
	const now = deps.now || Date.now;
	const setTimer = deps.setInterval || setInterval;
	const clearTimer = deps.clearInterval || clearInterval;
	const later = deps.setTimeout || setTimeout;
	const cancelLater = deps.clearTimeout || clearTimeout;

	let building = null;
	let queued = null;
	let queuedForce = false;
	let lookupTail = Promise.resolve();
	let lookupWaiting = null;
	// The lookup batch each build queued, keyed by its report, so a rescan waits for its own batch
	// and never for one an earlier build left behind.
	const batchOf = new WeakMap();
	let checking = null;
	let lastError = null;
	let lastPlayCheckAt = -Infinity;
	let lastRepairRebuildAt = -Infinity;
	let lastTagRebuildAt = -Infinity;
	let tagRebuildTimer = null;
	let timer = null;

	function enabled() {
		try {
			return getConfig().audiobooksEnabled === true;
		} catch (_) {
			return false;
		}
	}

	function onlineOn() {
		try {
			return getConfig().audiobookOnlineLookup === true;
		} catch (_) {
			return false;
		}
	}

	// Read here, after the last await of the build and right before replace(), so an edit written
	// while the build listed Plex is already in what replace() stores. A broken overrides file
	// keeps applyOverrides' result: resolving without the owner's edits would undo every one of
	// them on screen until the file is fixed.
	function resolveMetadata(works) {
		if (typeof store.metadataContext !== 'function') return works;
		try {
			const ctx = store.metadataContext();
			if (!ctx || ctx.error) return works;
			const meta = metadataLayer();
			const out = {};
			for (const [id, w] of Object.entries(works)) out[id] = meta.resolveWith(w, ctx);
			return out;
		} catch (err) {
			logger.warn('Audiobook metadata could not be applied to the new catalog; showing what detection found:', messageOf(err));
			return works;
		}
	}

	async function runLookup() {
		const lookup = lookupOf();
		// The catalog as it stands when the batch starts, so the works carry the titles get() will
		// be asked with, including a refresh that ran while the batch waited its turn.
		const works = Object.values((store.load() || {}).works || {});
		let overrides = {};
		try {
			overrides = store.readOverrides().overrides || {};
		} catch (_) {}
		const meta = metadataLayer();
		const overrideOf = (w) => meta.overrideFor(w, overrides);
		// A batch started elsewhere (a manual relookup) would hand back its own summary for its own
		// works; wait it out, then ask about this catalog.
		if (typeof lookup.isRunning === 'function' && lookup.isRunning()) await lookup.refresh([]);
		const summary = await lookup.refresh(works, { overrideOf });
		if (summary && Array.isArray(summary.changed) && summary.changed.length && typeof store.refreshMetadata === 'function') {
			const r = store.refreshMetadata();
			if (r && !r.ok) logger.warn(`Audiobook online details were looked up but not applied: ${r.error}`);
		}
		return summary || null;
	}

	// One batch at a time, and at most one waiting behind it: a batch looks at the whole catalog
	// when it starts, so a second waiting one would ask the same questions again.
	function queueLookup() {
		if (lookupWaiting) return lookupWaiting;
		const job = lookupTail.then(() => {
			lookupWaiting = null;
			return runLookup();
		}).catch((err) => {
			logger.warn('Audiobook online lookup failed:', messageOf(err));
			return null;
		});
		lookupWaiting = job;
		lookupTail = job;
		return job;
	}

	async function artistSections() {
		const res = await query('/library/sections');
		const dirs = (res && res.MediaContainer && Array.isArray(res.MediaContainer.Directory)) ? res.MediaContainer.Directory : [];
		return dirs.filter((d) => d && d.type === 'artist');
	}

	async function countTracks(key) {
		const res = await query(`/library/sections/${key}/all?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=0`);
		const mc = (res && res.MediaContainer) || {};
		return Number(mc.totalSize != null ? mc.totalSize : mc.size) || 0;
	}

	function signatureOf(section, totalSize) {
		return { scannedAt: section.scannedAt ?? null, updatedAt: section.updatedAt ?? null, totalSize };
	}

	function sameSignature(a, b) {
		const ka = Object.keys(a || {}).sort();
		const kb = Object.keys(b || {}).sort();
		if (ka.join() !== kb.join()) return false;
		return ka.every((k) => ['scannedAt', 'updatedAt', 'totalSize'].every((f) => String(a[k][f]) === String(b[k][f])));
	}

	async function probeChapters(work, tracksByKey, oldCache, newCache) {
		const out = {};
		for (const p of work.parts) {
			const t = tracksByKey.get(p.trackRatingKey);
			if (!t || !bookCatalog.wantsChapters(t)) continue;
			const cacheKey = `${p.trackRatingKey}:${p.sizeBytes}`;
			let entry = Object.prototype.hasOwnProperty.call(oldCache, cacheKey) ? oldCache[cacheKey] : undefined;
			if (entry === undefined) {
				try {
					const full = metadataOf(await query(`/library/metadata/${p.trackRatingKey}?includeChapters=1`))[0] || {};
					entry = bookCatalog.normalizeChapters(full.Chapter);
				} catch (err) {
					// Left uncached so the next build asks again; the part plays as one chapter meanwhile.
					logger.warn(`Audiobook chapter lookup failed for track ${p.trackRatingKey}:`, messageOf(err));
					continue;
				}
			}
			newCache[cacheKey] = entry;
			if (Array.isArray(entry)) out[p.trackRatingKey] = entry;
		}
		return out;
	}

	async function doRebuild({ force = false } = {}) {
		const sections = await artistSections();
		if (sections.some((s) => s.refreshing === true || s.refreshing === 1 || s.refreshing === '1')) {
			// A listing taken mid-scan can be missing whole folders, and replacing the catalog with
			// it would let those books into music until the next rebuild.
			return { ok: false, skipped: 'refreshing' };
		}
		const albums = [];
		const tracks = [];
		const signature = {};
		for (const s of sections) {
			const tRes = await query(`/library/sections/${s.key}/all?type=10&includeGuids=1`);
			const aRes = await query(`/library/sections/${s.key}/all?type=9&includeGuids=1`);
			const ts = metadataOf(tRes);
			const mc = (tRes && tRes.MediaContainer) || {};
			tracks.push(...ts);
			albums.push(...metadataOf(aRes));
			signature[String(s.key)] = signatureOf(s, Number(mc.totalSize != null ? mc.totalSize : (mc.size != null ? mc.size : ts.length)) || 0);
		}

		// Taken before replace(), which empties and refills this same object in place.
		const old = store.load();
		const oldWorks = old.works || {};
		const oldChapterCache = old.chapterCache || {};
		const oldCount = Object.keys(oldWorks).length;
		if (!tracks.length && oldCount && !force) {
			// An empty listing is far more often an unmounted drive than an emptied library.
			return { ok: false, skipped: 'empty-listing' };
		}

		const roots = rootsOf(sections);
		const samples = bookCatalog.tagSamples(tracks, { roots });
		const tagRead = await tagReader().read(samples, { budgetMs: TAG_BUDGET_MS, concurrency: TAG_CONCURRENCY });
		const tags = (tagRead && tagRead.byAlbum) || {};
		const trackTags = (tagRead && tagRead.byTrack) || {};
		if (tagRead && tagRead.pending > 0 && tagRead.settled) {
			logger.info(`Audiobook tag reads still running after ${TAG_BUDGET_MS / 1000} s (${tagRead.pending} left); the catalog is rebuilt once they finish.`);
			tagRead.settled.then((r) => { if (r && r.added > 0) scheduleTagRebuild(); }, () => {});
		}

		const { overrides: written, error: overridesError } = store.readOverrides();
		const first = bookCatalog.buildCatalog({ albums, tracks, overrides: written, tags, trackTags, roots });
		// The file is never rewritten for this, so the old catalog's ids and aliases carry an entry
		// forward on every build.
		const carry = bookCatalog.carryOverrides(written, oldWorks, first.works, bookCatalog.matchAliases(oldWorks, first.works).moved);
		const overrides = carry.overrides;
		const tracksByKey = new Map(tracks.map((t) => [String(t.ratingKey), t]));
		const chapterCache = {};
		const chapters = {};
		for (const w of Object.values(first.works)) {
			Object.assign(chapters, await probeChapters(w, tracksByKey, oldChapterCache, chapterCache));
		}
		const built = bookCatalog.buildCatalog({ albums, tracks, chapters, overrides, tags, trackTags, roots });
		const matched = bookCatalog.matchAliases(oldWorks, built.works);
		const moved = matched.moved;

		if (!Object.keys(matched.works).length && oldCount && !force) {
			return { ok: false, skipped: 'no-works' };
		}

		const notes = [
			...carry.carried.map((c) => `overrides for ${c.from} (${c.fields.join(', ')}) now apply to ${c.to}, the id detection gives it now`),
			...built.notes,
		];
		// Every build, the automatic ones included: an override that stopped applying would otherwise
		// be told only in the reply to a manual rescan.
		for (const note of notes) logger.warn(`Audiobook overrides: ${note}`);

		const works = resolveMetadata(matched.works);
		const persisted = store.replace({
			meta: {
				builtAt: now(),
				rulesVersion: bookCatalog.RULES_VERSION,
				sections: signature,
				overridesError: overridesError || null,
				roots,
			},
			works,
			rejected: built.rejected,
			splits: built.splits,
			chapterCache,
			index: built.index,
		});

		const oldIds = new Set(Object.keys(oldWorks));
		const newIds = Object.keys(works);
		const movedFrom = new Set(Object.keys(moved));
		const list = Object.values(works);
		const report = {
			ok: true,
			works: list.length,
			books: list.filter((w) => w.kind === 'book').length,
			podcasts: list.filter((w) => w.kind === 'podcast').length,
			parts: list.reduce((s, w) => s + w.parts.length, 0),
			totalMs: list.reduce((s, w) => s + (w.totalMs || 0), 0),
			added: newIds.filter((id) => !oldIds.has(id) && !Object.values(moved).includes(id)),
			removed: [...oldIds].filter((id) => !works[id] && !movedFrom.has(id)),
			moved,
			rejected: built.rejected.length,
			splits: built.splits,
			doubtful: list.filter((w) => Array.isArray(w.doubts) && w.doubts.length).map((w) => ({ id: w.id, doubts: w.doubts.length })),
			tags: { sampled: samples.length, pending: (tagRead && tagRead.pending) || 0, failed: (tagRead && tagRead.failed) || 0 },
			notes,
			overridesError: overridesError || null,
			persisted,
		};
		logger.info(`Audiobook catalog rebuilt: ${report.works} works (${report.books} books, ${report.podcasts} podcasts), ${report.parts} parts` +
			(report.added.length ? `, added ${report.added.length}` : '') +
			(report.removed.length ? `, removed ${report.removed.length}` : '') +
			(Object.keys(moved).length ? `, ${Object.keys(moved).length} renamed` : ''));
		if (onlineOn()) batchOf.set(report, queueLookup());
		return report;
	}

	/**
	 * Lists the library and replaces the catalog. One build at a time: a second call while one
	 * runs gets the same promise. Never throws.
	 * @returns {Promise<object>} { ok: true, works, books, podcasts, parts, totalMs, added,
	 *   removed, moved, rejected, splits, doubtful, tags, notes, overridesError, persisted } or
	 *   { ok: false, skipped } or { ok: false, error }. splits: music albums taken out of a
	 *   book's folder; doubtful: { id, doubts } per work with doubts; tags: { sampled, pending,
	 *   failed } from the tag read
	 * @param {{ force?: boolean, after?: 'current' }} [opts] after 'current': when a build is
	 *   already running, the caller changed something that build read too early (overrides, the
	 *   tag cache), so exactly one more build follows it; every such call made meanwhile shares it
	 */
	function rebuild({ force = false, after } = {}) {
		if (building && after === 'current') {
			queuedForce = queuedForce || force;
			if (!queued) {
				const next = () => {
					const f = queuedForce;
					queued = null;
					queuedForce = false;
					return rebuild({ force: f });
				};
				queued = building.then(next, next);
			}
			return queued;
		}
		if (building) return building;
		building = (async () => {
			try {
				const report = await doRebuild({ force });
				if (report.ok) lastError = null;
				return report;
			} catch (err) {
				lastError = messageOf(err);
				logger.error('Audiobook catalog rebuild failed:', lastError);
				return { ok: false, error: lastError };
			} finally {
				building = null;
			}
		})();
		return building;
	}

	async function doCheck(reason) {
		const meta = store.meta() || {};
		const sections = await artistSections();
		if (sections.some((s) => s.refreshing === true || s.refreshing === 1 || s.refreshing === '1')) {
			return { action: 'skipped', reason: 'refreshing' };
		}
		let why = null;
		if (!meta.builtAt || !Object.keys(store.load().works || {}).length) why = 'no catalog';
		else if (meta.rulesVersion !== bookCatalog.RULES_VERSION) why = 'rules changed';
		else if (now() - meta.builtAt >= MAX_CATALOG_AGE_MS) why = 'older than a day';
		else {
			const signature = {};
			for (const s of sections) signature[String(s.key)] = signatureOf(s, await countTracks(s.key));
			if (!sameSignature(signature, meta.sections)) why = 'library changed';
		}
		if (!why) return { action: 'fresh', reason };
		const report = await rebuild();
		return { action: 'rebuilt', why, reason, report };
	}

	/**
	 * Rebuilds only when the library changed. reason 'play' is limited to once an hour; the
	 * hourly timer and start() are not. Never throws.
	 * @param {{ reason?: 'start'|'hourly'|'play'|string }} [opts]
	 * @returns {Promise<{ action: 'fresh'|'rebuilt'|'skipped'|'building'|'error', ... }>}
	 */
	function ensureFresh({ reason = 'check' } = {}) {
		if (building) return Promise.resolve({ action: 'building', reason });
		if (checking) return checking;
		if (reason === 'play') {
			if (now() - lastPlayCheckAt < PLAY_CHECK_MIN_GAP_MS) return Promise.resolve({ action: 'skipped', reason: 'rate-limited' });
			lastPlayCheckAt = now();
		}
		checking = (async () => {
			try {
				return await doCheck(reason);
			} catch (err) {
				lastError = messageOf(err);
				logger.warn('Audiobook library check failed:', lastError);
				return { action: 'error', reason, error: lastError };
			} finally {
				checking = null;
			}
		})();
		return checking;
	}

	function tick() {
		if (!enabled()) return null;
		return ensureFresh({ reason: 'hourly' });
	}

	/**
	 * Arms the hourly check and runs one now. Does nothing while audiobooks are disabled: no
	 * timer, no Plex call.
	 * @returns {Promise<object>|null} the first check, for tests and boot logging
	 */
	function start() {
		if (!enabled()) return null;
		if (!timer) {
			timer = setTimer(tick, CHECK_INTERVAL_MS);
			if (timer && typeof timer.unref === 'function') timer.unref();
		}
		return ensureFresh({ reason: 'start' });
	}

	function stop() {
		if (timer) clearTimer(timer);
		timer = null;
		if (tagRebuildTimer) cancelLater(tagRebuildTimer);
		tagRebuildTimer = null;
	}

	function scheduleRebuild() {
		if (now() - lastRepairRebuildAt < REPAIR_REBUILD_MIN_GAP_MS) return false;
		lastRepairRebuildAt = now();
		rebuild().catch(() => {});
		return true;
	}

	// Tags that arrived after a build gave up waiting. Waits out a build already running (it read
	// the older cache), and at most one such rebuild per 10 minutes; a later one is deferred to the
	// end of that gap rather than dropped, since nothing else would rebuild for a day.
	function scheduleTagRebuild() {
		if (tagRebuildTimer) return;
		const wait = lastTagRebuildAt + TAG_REBUILD_MIN_GAP_MS - now();
		const go = () => {
			tagRebuildTimer = null;
			if (!enabled()) return;
			lastTagRebuildAt = now();
			rebuild({ after: 'current' }).catch(() => {});
		};
		if (wait <= 0) return go();
		tagRebuildTimer = later(go, wait);
		if (tagRebuildTimer && typeof tagRebuildTimer.unref === 'function') tagRebuildTimer.unref();
	}

	/**
	 * Finds a part's key again through its track's own ratingKey, accepting it only when the file
	 * basename still matches. A track that is gone, or now points at another file, schedules a
	 * rebuild (at most every 10 min) and gives null; the caller ends the session with the place saved.
	 * @returns {Promise<string|null>}
	 */
	async function repairPartKey(work, part) {
		if (!part || part.trackRatingKey === undefined || part.trackRatingKey === null) return null;
		const workId = work && work.id;
		let md;
		try {
			md = metadataOf(await query(`/library/metadata/${part.trackRatingKey}`))[0];
		} catch (err) {
			const msg = messageOf(err);
			if (/response code: 404\b/.test(msg)) {
				scheduleRebuild();
			} else {
				logger.warn(`Audiobook part key repair failed for track ${part.trackRatingKey}:`, msg);
			}
			return null;
		}
		const p = md && md.Media && md.Media[0] && md.Media[0].Part && md.Media[0].Part[0];
		const want = bookCatalog.basename(part.file).toLowerCase();
		if (!p || !p.key || !want || bookCatalog.basename(p.file).toLowerCase() !== want) {
			scheduleRebuild();
			return null;
		}
		store.setPartKey(workId, { trackRatingKey: part.trackRatingKey, file: part.file }, p.key);
		return p.key;
	}

	/** @returns {'empty'|'ready'|'building'|'error'} */
	function status() {
		if (building) return 'building';
		if (Object.keys(store.load().works || {}).length) return 'ready';
		return lastError ? 'error' : 'empty';
	}

	/**
	 * The online lookup batch a build queued, for `!book rescan` to wait on. Resolves to
	 * bookLookup's refresh() summary, after its fills are in the catalog, or null when the batch
	 * failed. Never rejects.
	 * @param {object} report what rebuild() resolved to
	 * @returns {Promise<object|null>|null} null when that build queued none (the setting is off,
	 *   or the build did not replace the catalog)
	 */
	function onlineBatch(report) {
		return (report && typeof report === 'object' && batchOf.get(report)) || null;
	}

	return {
		start,
		stop,
		ensureFresh,
		rebuild,
		onlineBatch,
		repairPartKey,
		status,
		lastError: () => lastError,
		armed: () => !!timer,
	};
}

const library = createLibrary();

module.exports = { ...library, createLibrary };
