// helpers/bookTextStore.js
//
// The read-along's three small JSON files under data/book_text/:
//
//   links.json    the ebook the owner tied to a work with `!book link` (or "off"), by work id
//   readers.json  who turned `!book text on`, by Discord user id
//   works.json    which cached text each work currently uses (a pointer to content-addressed
//                 files in data/book_text/cache/, see helpers/bookTextSource.js)
//
// Links and pointers are looked up by work id and then by each of the work's aliases, so a
// catalog rebuild that renames a work keeps both. A pointer found through an alias is copied to
// the new id; the cache files are named after the ebook, not the work, so nothing is renamed.

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

/** Test seam: forget all three in-memory copies so the next read comes off disk. */
function reset() {
	linksStore.reset();
	readersStore.reset();
	worksStore.reset();
}

module.exports = {
	links,
	readers,
	works,
	reset,
	files: { links: linksStore.file, readers: readersStore.file, works: worksStore.file },
	healthy: () => linksStore.healthy() && readersStore.healthy() && worksStore.healthy()
};
