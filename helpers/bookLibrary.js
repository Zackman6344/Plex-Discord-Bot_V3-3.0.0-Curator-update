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

const logger = require('./logger.js');
const bookCatalog = require('./bookCatalog.js');

const HOUR = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = HOUR;
const PLAY_CHECK_MIN_GAP_MS = HOUR;
const MAX_CATALOG_AGE_MS = 24 * HOUR;
const REPAIR_REBUILD_MIN_GAP_MS = 10 * 60 * 1000;

function metadataOf(res) {
	return (res && res.MediaContainer && Array.isArray(res.MediaContainer.Metadata)) ? res.MediaContainer.Metadata : [];
}

function redact(text) {
	return String(text || '').replace(/(X-Plex-Token[=:]\s*)[^&\s]+/gi, '$1REDACTED');
}

function messageOf(err) {
	return redact(err && err.message ? err.message : err);
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
 */
function createLibrary(deps = {}) {
	const query = deps.query || ((p) => require('./plexClient.js').getPlex().query(p));
	const store = deps.store || require('./bookCatalogStore.js');
	const getConfig = deps.getConfig || (() => require('../config/config.js'));
	const now = deps.now || Date.now;
	const setTimer = deps.setInterval || setInterval;
	const clearTimer = deps.clearInterval || clearInterval;

	let building = null;
	let checking = null;
	let lastError = null;
	let lastPlayCheckAt = -Infinity;
	let lastRepairRebuildAt = -Infinity;
	let timer = null;

	function enabled() {
		try {
			return getConfig().audiobooksEnabled === true;
		} catch (_) {
			return false;
		}
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

		const { overrides, error: overridesError } = store.readOverrides();
		const first = bookCatalog.buildCatalog({ albums, tracks, overrides });
		const tracksByKey = new Map(tracks.map((t) => [String(t.ratingKey), t]));
		const chapterCache = {};
		const chapters = {};
		for (const w of Object.values(first.works)) {
			Object.assign(chapters, await probeChapters(w, tracksByKey, oldChapterCache, chapterCache));
		}
		const built = bookCatalog.buildCatalog({ albums, tracks, chapters, overrides });
		const { works, moved } = bookCatalog.matchAliases(oldWorks, built.works);

		if (!Object.keys(works).length && oldCount && !force) {
			return { ok: false, skipped: 'no-works' };
		}

		const persisted = store.replace({
			meta: {
				builtAt: now(),
				rulesVersion: bookCatalog.RULES_VERSION,
				sections: signature,
				overridesError: overridesError || null,
			},
			works,
			rejected: built.rejected,
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
			notes: built.notes,
			overridesError: overridesError || null,
			persisted,
		};
		logger.info(`Audiobook catalog rebuilt: ${report.works} works (${report.books} books, ${report.podcasts} podcasts), ${report.parts} parts` +
			(report.added.length ? `, added ${report.added.length}` : '') +
			(report.removed.length ? `, removed ${report.removed.length}` : '') +
			(Object.keys(moved).length ? `, ${Object.keys(moved).length} renamed` : ''));
		return report;
	}

	/**
	 * Lists the library and replaces the catalog. One build at a time: a second call while one
	 * runs gets the same promise. Never throws.
	 * @returns {Promise<object>} { ok: true, works, books, podcasts, parts, totalMs, added,
	 *   removed, moved, rejected, notes, overridesError, persisted } or { ok: false, skipped }
	 *   or { ok: false, error }
	 */
	function rebuild({ force = false } = {}) {
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
	}

	function scheduleRebuild() {
		if (now() - lastRepairRebuildAt < REPAIR_REBUILD_MIN_GAP_MS) return false;
		lastRepairRebuildAt = now();
		rebuild().catch(() => {});
		return true;
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

	return {
		start,
		stop,
		ensureFresh,
		rebuild,
		repairPartKey,
		status,
		lastError: () => lastError,
		armed: () => !!timer,
	};
}

const library = createLibrary();

module.exports = { ...library, createLibrary };
