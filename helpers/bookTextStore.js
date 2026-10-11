// helpers/bookTextStore.js
//
// The read-along's small JSON files under data/book_text/:
//
//   links.json    the ebook the owner tied to a work with `!book link` (or "off"), by work id
//   readers.json  who turned `!book text on`, by Discord user id
//   works.json    which cached text each work currently uses (a pointer to content-addressed
//                 files in data/book_text/cache/, see helpers/bookTextSource.js)
//   marks.json    the listeners' sync marks, by work id: shared by everyone who plays that
//                 recording
//
// Links, pointers and marks are looked up by work id and then by each of the work's aliases, so a
// catalog rebuild that renames a work keeps both. A pointer found through an alias is copied to
// the new id; the cache files are named after the ebook, not the work, so nothing is renamed.

const crypto = require('crypto');
const path = require('path');
const { createStore } = require('./jsonStore.js');

const DIR = path.join(__dirname, '..', 'data', 'book_text');

function store(envVar, file, key, label) {
	return createStore({
		envVar,
		defaultPath: path.join(DIR, file),
		key,
		shape: 'object',
		label,
		feature: 'Read-along',
		// Keyed by work ids built from folder names and by Discord ids.
		nullPrototype: true
	});
}

const linksStore = store('PLEXBOT_BOOK_TEXT_LINKS_FILE', 'links.json', 'links', 'ebook link');
const readersStore = store('PLEXBOT_BOOK_TEXT_READERS_FILE', 'readers.json', 'readers', 'reader');
const worksStore = store('PLEXBOT_BOOK_TEXT_WORKS_FILE', 'works.json', 'works', 'text pointer');

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const copy = (v) => (isObject(v) ? JSON.parse(JSON.stringify(v)) : null);

function idsOf(work) {
	if (typeof work === 'string') return work ? [work] : [];
	if (!work || typeof work.id !== 'string') return [];
	const aliases = Array.isArray(work.aliases) ? work.aliases.filter((a) => typeof a === 'string' && a) : [];
	return [work.id, ...aliases];
}

function idOf(work) {
	return idsOf(work)[0] || null;
}

/** @returns {{ id: string, value: object } | null} the first entry found by id, then by alias */
function find(s, work) {
	const all = s.load();
	for (const id of idsOf(work)) {
		if (has(all, id) && isObject(all[id])) return { id, value: all[id] };
	}
	return null;
}

function keyed(s) {
	return {
		set(workId, value) {
			if (typeof workId !== 'string' || !workId || !isObject(value)) return false;
			s.load()[workId] = copy(value);
			return s.persist();
		},
		// Drops the entry under every name the work has had, so an old alias entry cannot come
		// back once the current one is gone.
		clear(work) {
			const all = s.load();
			let changed = false;
			for (const id of idsOf(work)) {
				if (has(all, id)) {
					delete all[id];
					changed = true;
				}
			}
			return changed ? s.persist() : true;
		},
		all() {
			return copy(Object.assign({}, s.load())) || {};
		}
	};
}

const links = Object.assign(keyed(linksStore), {
	get(work) {
		const hit = find(linksStore, work);
		return hit ? copy(hit.value) : null;
	}
});

const works = Object.assign(keyed(worksStore), {
	get(work) {
		const hit = find(worksStore, work);
		if (!hit) return null;
		const id = idOf(work);
		if (hit.id !== id) {
			worksStore.load()[id] = copy(hit.value);
			worksStore.persist();
		}
		return copy(hit.value);
	},
	// The same lookup without the alias copy, for callers that must not write (a card render).
	peek(work) {
		const hit = find(worksStore, work);
		return hit ? copy(hit.value) : null;
	}
});

const readers = {
	isOn(userId) {
		const all = readersStore.load();
		const k = String(userId || '');
		return !!k && has(all, k) && isObject(all[k]) && all[k].on === true;
	},
	set(userId, on, now = Date.now()) {
		const k = String(userId || '');
		if (!k) return false;
		const all = readersStore.load();
		if (on) {
			if (has(all, k) && isObject(all[k]) && all[k].on === true) return true;
			all[k] = { on: true, since: now };
		} else {
			if (!has(all, k)) return true;
			delete all[k];
		}
		return readersStore.persist();
	},
	all() {
		return copy(Object.assign({}, readersStore.load())) || {};
	}
};

// Sync marks, shared by everyone who plays the recording: { [workId]: { marks: [...] } }. Each
// mark is { id, ms, word, text, tag, rec, by, at }: an audio time, a global word index, the cache
// base of the ebook text it was made against, the recording's fingerprint
// (readAlongModel.recordingOf), who made it and when. No book text.
const marksStore = store('PLEXBOT_BOOK_TEXT_MARKS_FILE', 'marks.json', 'marks', 'mark');

const MARK_FIELDS = ['id', 'ms', 'word', 'text', 'tag', 'rec', 'by', 'at'];

function cleanMark(m) {
	if (!isObject(m)) return null;
	const ms = Number(m.ms);
	const word = Number(m.word);
	if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(word) || word < 0) return null;
	if (typeof m.text !== 'string' || !m.text) return null;
	const out = {};
	for (const k of MARK_FIELDS) out[k] = m[k] === undefined ? null : m[k];
	out.ms = Math.round(ms);
	out.rec = typeof out.rec === 'string' && out.rec ? out.rec : null;
	out.by = out.by === null ? null : String(out.by);
	out.at = Number(out.at) || 0;
	return out;
}

function marksEntry(work) {
	const hit = find(marksStore, work);
	const list = hit && Array.isArray(hit.value.marks) ? hit.value.marks.map(cleanMark).filter(Boolean) : [];
	return { hit, list };
}

// Writes the list under the work's current id and drops the copies under its old ids, so a
// rename never leaves two lists that drift apart.
function writeMarks(work, list) {
	const id = idOf(work);
	if (!id) return false;
	const all = marksStore.load();
	for (const old of idsOf(work)) if (has(all, old)) delete all[old];
	if (list.length) all[id] = { marks: list.map((m) => Object.assign({}, m)) };
	return marksStore.persist();
}

const byTime = (a, b) => (a.ms - b.ms) || (a.at - b.at);

const marks = {
	/** @returns {object[]} the work's marks by audio time, every text version included */
	list(work) {
		return marksEntry(work).list.sort(byTime);
	},
	/**
	 * Adds a mark, replacing the marks of the same text and recording it would duplicate: within
	 * `nearMs` of audio, or on the same word.
	 * @returns {{ ok: boolean, mark?: object, replaced: object[] }}
	 */
	add(work, mark, { nearMs = 20000 } = {}) {
		const m = cleanMark(Object.assign({ id: crypto.randomBytes(4).toString('hex') }, mark));
		if (!m || !idOf(work)) return { ok: false, replaced: [] };
		const { list } = marksEntry(work);
		const sameRec = (x) => !x.rec || !m.rec || x.rec === m.rec;
		const near = (x) => x.text === m.text && sameRec(x) && (Math.abs(x.ms - m.ms) <= nearMs || x.word === m.word);
		const replaced = list.filter(near);
		const next = list.filter((x) => !near(x)).concat([m]).sort(byTime);
		return { ok: writeMarks(work, next), mark: Object.assign({}, m), replaced };
	},
	/** @returns {{ ok: boolean, removed: object[] }} */
	remove(work, ids) {
		const drop = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
		const { list } = marksEntry(work);
		const removed = list.filter((x) => drop.has(String(x.id)));
		if (!removed.length) return { ok: true, removed };
		return { ok: writeMarks(work, list.filter((x) => !drop.has(String(x.id)))), removed };
	},
	/** @returns {{ ok: boolean, removed: object[] }} every mark of the work, every text version */
	clear(work) {
		const { list } = marksEntry(work);
		const all = marksStore.load();
		const named = idsOf(work).some((id) => has(all, id));
		if (!named) return { ok: true, removed: [] };
		return { ok: writeMarks(work, []), removed: list };
	},
	all() {
		return copy(Object.assign({}, marksStore.load())) || {};
	}
};

/** Test seam: forget every in-memory copy so the next read comes off disk. */
function reset() {
	linksStore.reset();
	readersStore.reset();
	worksStore.reset();
	marksStore.reset();
}

module.exports = {
	links,
	readers,
	works,
	marks,
	reset,
	files: { links: linksStore.file, readers: readersStore.file, works: worksStore.file, marks: marksStore.file },
	healthy: () => linksStore.healthy() && readersStore.healthy() && worksStore.healthy() && marksStore.healthy()
};
