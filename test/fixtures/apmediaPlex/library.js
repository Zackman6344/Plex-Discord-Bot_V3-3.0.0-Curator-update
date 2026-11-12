// test/fixtures/apmediaPlex/library.js
// A small invented Plex library in the shapes PMS 1.43.5 sends (ratingKey, key and section keys as
// strings; index, duration, year, viewedAt and accountID as numbers), for the Plex Media YAML
// builder tests, plus fakes of the book catalog, longForm and bookmarks.
//
// What it holds on purpose: a movie watched by account 5 and another watched only by the owner
// (account 1); a show whose friend history has a gap (S1E1, S1E2, S1E4 seen); a fully watched
// show; an unmatched show; specials; album copies on two drives under one guid (equal and unequal
// track counts); albums that fail curation (too few long tracks, too many tracks, the placeholders
// Plex and its uploaders make, an unmatched guid, a catalogued book album, an album with one book
// track); audio and video playlists; a movie and a TV collection. Field names starting with `_`
// stay in the fixture.

const MIN = 60000;
const BOOK_ALBUM = '3007';
const BOOK_ARTIST = '9007';

function part(id) {
	return [{ Part: [{ id, key: `/library/parts/${id}/1700000000/file-${id}.flac` }] }];
}

function movie(rk, title, year, minutes, genres = [], guid = `plex://movie/m${rk}`) {
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}`, guid, type: 'movie', title, year,
		duration: Math.round(minutes * MIN), Media: part(900000 + rk), _genres: genres,
	};
}

function episodes(show, seasons) {
	const out = [];
	let rk = Number(show.ratingKey) * 100 + 1;
	for (const [sn, count, minutes = 30] of seasons) {
		for (let en = 1; en <= count; en++) {
			const guid = show.guid.startsWith('plex://') ? `plex://episode/${show.ratingKey}-${sn}-${en}` : `local://${rk}`;
			out.push({
				ratingKey: String(rk), key: `/library/metadata/${rk}`, guid, type: 'episode',
				title: sn === 0 ? `Special ${en}` : `Episode Title ${sn}x${en}`,
				parentIndex: sn, index: en, duration: minutes * MIN,
				grandparentRatingKey: show.ratingKey, grandparentGuid: show.guid, grandparentTitle: show.title,
				parentRatingKey: `${show.ratingKey}${sn}`, Media: part(800000 + rk),
			});
			rk += 1;
		}
	}
	return out;
}

function show(rk, title, year, genres = [], guid = `plex://show/s${rk}`) {
	return { ratingKey: String(rk), key: `/library/metadata/${rk}/children`, guid, type: 'show', title, year, _genres: genres };
}

function album(rk, artist, title, year, guid, genres = []) {
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}/children`, guid, type: 'album', title,
		parentTitle: artist, parentRatingKey: String(9000 + (rk % 100)), year, Genre: genres.map((tag) => ({ tag })),
	};
}

function tracks(albumRow, seconds, { trackArtists = [] } = {}) {
	return seconds.map((s, i) => {
		const rk = Number(albumRow.ratingKey) * 100 + i + 1;
		const t = {
			ratingKey: String(rk), key: `/library/metadata/${rk}`, type: 'track', title: `${albumRow.title} Song ${i + 1}`,
			index: i + 1, parentIndex: 1, duration: s * 1000, parentRatingKey: albumRow.ratingKey,
			grandparentTitle: albumRow.parentTitle, parentTitle: albumRow.title, Media: part(400000 + rk),
		};
		if (trackArtists[i]) t.originalTitle = trackArtists[i];
		return t;
	});
}

function looseTrack(rk, title, artist, seconds, albumArtist = 'Various Artists') {
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}`, type: 'track', title, index: 1, parentIndex: 1,
		duration: seconds * 1000, grandparentTitle: albumArtist, originalTitle: artist, Media: part(400000 + rk),
	};
}

/**
 * @param {object} [opts]
 * @param {number} [opts.hugeShowEpisodes] adds "Huge Show" (rk 2099) with this many 30-minute episodes
 * @param {number} [opts.bigAudioPlaylist] adds the smart audio playlist "Everything Ever" (rk 5007)
 *   with this many 200-second tracks
 * @param {number} [opts.bigVideoPlaylist] adds the smart video playlist "Every Movie" (rk 5008) with
 *   this many 90-minute movies that are in no section
 */
function buildLibrary({ hugeShowEpisodes = 0, bigAudioPlaylist = 0, bigVideoPlaylist = 0 } = {}) {
	const LS = String.fromCharCode(0x2028);
	const movies = [
		movie(1001, 'Alien', 1979, 117, ['10', '12']),
		movie(1002, 'Aliens', 1986, 137, ['10', '12']),
		movie(1003, 'Alien 3', 1992, 114, ['10']),
		movie(1004, 'The Matrix', 1999, 136, ['12']),
		movie(1005, 'Heat', 1995, 170),
		movie(1006, 'Up', 2009, 96, ['11']),
		movie(1007, 'Inception', 2010, 148, ['12']),
		movie(1008, 'Arrival', 2016, 116, ['12']),
		movie(1009, 'Dune', 2021, 155, ['12']),
		movie(1010, 'Paddington', 2014, 95, ['11']),
		movie(1011, 'Hot Fuzz', 2007, 121, ['11']),
		movie(1012, 'Jaws', 1975, 124, ['10']),
		movie(1013, 'Moon', 2009, 97, ['12']),
		movie(1014, `Line${LS}Break "Quoted": #1`, 2011, 101),
		movie(1015, 'Zodiac', 2007, 157),
		movie(1016, 'Her', 2013, 126),
		movie(1017, 'Gravity', 2013, 91, ['12']),
		movie(1018, 'Coco', 2017, 105, ['11']),
		movie(1019, 'Home Video', 2015, 45, [], 'local://1019'),
		movie(1020, 'Broken File', 2020, 0),
	];

	const bb = show(2001, 'Breaking Bad', 2008, ['13']);
	const local = show(2002, 'Local Show', 2015, [], 'local://2002');
	const cosmos = show(2003, 'Cosmos', 1980, ['14']);
	const watchedShow = show(2004, 'Watched Show', 2010);
	const shows = [bb, local, cosmos, watchedShow];
	const leaves = {
		2001: episodes(bb, [[0, 2, 10], [1, 7, 48], [2, 13, 47]]),
		2002: episodes(local, [[1, 5, 22]]),
		2003: episodes(cosmos, [[1, 13, 60]]),
		2004: episodes(watchedShow, [[1, 3, 25]]),
	};
	if (hugeShowEpisodes > 0) {
		const huge = show(2099, 'Huge Show', 1999);
		shows.push(huge);
		leaves[2099] = episodes(huge, [[1, hugeShowEpisodes, 30]]);
	}

	const albums = [
		album(3001, 'Daft Punk', 'Discovery', 2001, 'plex://album/disc', ['Electronic']),
		album(3002, 'Daft Punk', 'Discovery', 2001, 'plex://album/disc', ['Electronic']),
		album(3003, 'Daft Punk', 'Homework', 1997, 'plex://album/home', ['Electronic']),
		album(3004, 'Big Band', 'Big Album', 2005, 'plex://album/big'),
		album(3005, 'Various Artists', 'music uploads', 2019, 'plex://album/vau'),
		album(3006, 'Someone', 'Unmatched', 2012, 'local://3006'),
		album(3007, 'Avery Quill', 'The Book Album', 2020, 'plex://album/book'),
		album(3008, 'X', 'Mixed Bag', 2018, 'plex://album/mixed'),
		album(3009, 'Daft Punk', 'Random Access Memories', 2013, 'plex://album/ram', ['Electronic']),
		album(3010, 'Daft Punk', 'Random Access Memories', 2013, 'plex://album/ram', ['Electronic']),
		album(3011, 'Miles Davis', 'Kind of Blue', 1959, 'mbid://kob', ['Jazz']),
		album(3012, 'The Beatles', 'Abbey Road', 1969, 'plex://album/abbey', ['Rock']),
		album(3013, 'Comedian', 'Skits', 2003, 'plex://album/skits'),
		album(3014, 'Music', 'Music Uploads', 2019, 'plex://album/uploads'),
		album(3015, 'Some Band', '[Unknown Album]', 2018, 'plex://album/unknown'),
		album(3016, '', 'Nameless', 2017, 'plex://album/nameless'),
	];
	albums[6].parentRatingKey = BOOK_ARTIST;
	const byRk = Object.fromEntries(albums.map((a) => [a.ratingKey, a]));
	const children = {
		3001: tracks(byRk[3001], [320, 212, 301, 230]),
		3002: tracks(byRk[3002], [320, 212, 301, 230]),
		3003: tracks(byRk[3003], [20, 300, 250]),
		3004: tracks(byRk[3004], Array.from({ length: 45 }, () => 180)),
		3005: tracks(byRk[3005], [200, 200, 200]),
		3006: tracks(byRk[3006], [200, 200, 200]),
		3007: tracks(byRk[3007], [3600, 3600, 3600]),
		3008: tracks(byRk[3008], [200, 200, 200, 200]),
		3009: tracks(byRk[3009], [275, 369, 290, 337, 228]),
		3010: tracks(byRk[3010], [275, 369, 290, 337, 228, 160]),
		3011: tracks(byRk[3011], [562, 566, 337, 691, 571], { trackArtists: ['Miles Davis Sextet'] }),
		3012: tracks(byRk[3012], Array.from({ length: 17 }, (_, i) => (i === 3 ? 23 : 150 + i))),
		3013: tracks(byRk[3013], [20, 25, 12]),
		3014: tracks(byRk[3014], [200, 200, 200]),
		3015: tracks(byRk[3015], [200, 200, 200]),
		3016: tracks(byRk[3016], [200, 200, 200]),
	};
	const bookTracks = new Set([...children[3007].map((t) => t.ratingKey), children[3008][2].ratingKey, '59999']);

	const bumps = Array.from({ length: 32 }, (_, i) => looseTrack(51001 + i, `Bump ${i + 1}`, `Artist ${i % 5}`, 150 + i));
	bumps.splice(10, 0, looseTrack(59999, 'Chapter 7', 'Avery Quill', 1200));
	const playlists = [
		{ ratingKey: '5001', key: '/playlists/5001/items', type: 'playlist', title: 'Boardwalk Bumps', playlistType: 'audio', smart: false, leafCount: 33 },
		{ ratingKey: '5002', key: '/playlists/5002/items', type: 'playlist', title: 'Lofi', playlistType: 'audio', smart: false, leafCount: 10 },
		{ ratingKey: '5003', key: '/playlists/5003/items', type: 'playlist', title: 'MCU Timeline', playlistType: 'video', smart: false, leafCount: 4 },
		{ ratingKey: '5004', key: '/playlists/5004/items', type: 'playlist', title: 'Beach Photos', playlistType: 'photo', smart: false, leafCount: 3 },
		{ ratingKey: '5005', key: '/playlists/5005/items', type: 'playlist', title: 'All Music', playlistType: 'audio', smart: true, leafCount: 5 },
		{ ratingKey: '5006', key: '/playlists/5006/items', type: 'playlist', title: 'Interludes', playlistType: 'audio', smart: false, leafCount: 18 },
	];
	const playlistItems = {
		5001: bumps,
		5002: Array.from({ length: 10 }, (_, i) => looseTrack(52001 + i, `Lofi ${i + 1}`, 'Chill Person', 120)),
		5003: [movies[3], leaves[2001][4], movies[0], leaves[2001][0]],
		5005: children[3012].slice(0, 5),
		5006: Array.from({ length: 18 }, (_, i) => looseTrack(53001 + i, `Interlude ${i + 1}`, 'Band', i < 15 ? 200 : 15)),
	};
	if (bigAudioPlaylist > 0) {
		playlists.push({ ratingKey: '5007', key: '/playlists/5007/items', type: 'playlist', title: 'Everything Ever', playlistType: 'audio', smart: true, leafCount: bigAudioPlaylist });
		playlistItems[5007] = Array.from({ length: bigAudioPlaylist }, (_, i) => looseTrack(600001 + i, `Song ${i + 1}`, `Artist ${i % 50}`, 200));
	}
	if (bigVideoPlaylist > 0) {
		playlists.push({ ratingKey: '5008', key: '/playlists/5008/items', type: 'playlist', title: 'Every Movie', playlistType: 'video', smart: true, leafCount: bigVideoPlaylist });
		playlistItems[5008] = Array.from({ length: bigVideoPlaylist }, (_, i) => movie(700001 + i, `Film ${i + 1}`, 2000, 90));
	}

	const collections = {
		3: [{ ratingKey: '6001', key: '/library/collections/6001/children', type: 'collection', title: 'Alien Collection', subtype: 'movie', smart: '0', childCount: '3' }],
		4: [{ ratingKey: '6002', key: '/library/collections/6002/children', type: 'collection', title: 'Space Shows', subtype: 'show', smart: '0', childCount: '1' }],
	};
	const collectionItems = { 6001: movies.slice(0, 3), 6002: [cosmos] };

	const genres = {
		3: [{ key: '10', title: 'Horror' }, { key: '11', title: 'Comedy' }, { key: '12', title: 'Science Fiction' }],
		4: [{ key: '13', title: 'Drama' }, { key: '14', title: 'Documentary' }],
	};

	let hk = 1;
	const hist = (accountID, rk, section, type, viewedAt) => ({
		historyKey: `/status/sessions/history/${hk++}`, key: `/library/metadata/${rk}`, ratingKey: String(rk),
		librarySectionID: String(section), type, viewedAt, accountID, deviceID: 3,
	});
	const history = [
		hist(5, 1001, 3, 'movie', 1760000000),
		hist(1, 1002, 3, 'movie', 1760000100),
		hist(5, 200103, 4, 'episode', 1760000200),
		hist(5, 200104, 4, 'episode', 1760000300),
		hist(5, 200106, 4, 'episode', 1760000400),
		hist(5, 200401, 4, 'episode', 1760000500),
		hist(5, 200402, 4, 'episode', 1760000600),
		hist(5, 200403, 4, 'episode', 1760000700),
		hist(5, 300101, 1, 'track', 1760000800),
		{ historyKey: `/status/sessions/history/${hk++}`, librarySectionID: '3', type: 'movie', viewedAt: 1760000900, accountID: 5 },
	];

	return {
		sections: [
			{ key: '3', type: 'movie', title: 'Movies' },
			{ key: '4', type: 'show', title: 'TV Shows' },
			{ key: '1', type: 'artist', title: 'Music' },
		],
		movies,
		shows,
		leaves,
		albums,
		children,
		bookTracks,
		playlists,
		playlistItems,
		collections,
		collectionItems,
		genres,
		history,
		accounts: [{ id: 0, name: '' }, { id: 1, name: 'Owner' }, { id: 5, name: 'Friend' }],
	};
}

function fakeLongForm(lib) {
	const isBook = (t) => lib.bookTracks.has(String(t.ratingKey));
	return {
		enabled: () => true,
		withExclusion: (url) => `${url}${String(url).includes('?') ? '&' : '?'}album.id!=${BOOK_ALBUM}&artist.id!=${BOOK_ARTIST}`,
		isLongFormAlbum: (a) => String(a.ratingKey) === BOOK_ALBUM || String(a.parentRatingKey) === BOOK_ARTIST,
		partition: (list) => ({ music: list.filter((t) => !isBook(t)), books: list.filter(isBook) }),
	};
}

function workPart(ordinal, trackRk, partId, ms) {
	return { ordinal, albumRatingKey: '7000', trackRatingKey: String(trackRk), title: `Part ${ordinal}`, durationMs: ms, partKey: `/library/parts/${partId}/1700000000/p${ordinal}.mp3` };
}

function fakeCatalog() {
	const works = [
		{ id: 'avery-quill/the-glass-road', kind: 'book', title: 'The Glass Road', author: 'Avery Quill', aliases: ['old-id/glass-road'], genres: ['Fantasy'],
			parts: [workPart(2, 70002, 80002, 5400000), workPart(1, 70001, 80001, 3600000)] },
		{ id: 'b/second', kind: 'book', title: 'Second Book', author: 'B Author', aliases: [], genres: ['Science Fiction'], parts: [workPart(1, 70011, 80011, 7200000)] },
		{ id: 'c/third', kind: 'book', title: 'Third Book', author: '', aliases: [], genres: [], parts: [workPart(1, 70021, 80021, 1800000)] },
		{ id: 'pod/cast', kind: 'podcast', title: 'The Podcast', author: 'Host', aliases: [], genres: ['Podcasts'], parts: [workPart(1, 70031, 80031, 2700000)] },
		{ id: 'empty/work', kind: 'book', title: 'Empty Work', author: 'Nobody', aliases: [], genres: [], parts: [] },
	];
	const byId = new Map(works.map((w) => [w.id, w]));
	return {
		works: () => works,
		work: (id) => byId.get(id) || works.find((w) => w.aliases.includes(id)) || null,
		findWorks: (text) => works.filter((w) => w.title.toLowerCase().includes(String(text).toLowerCase())),
	};
}

function fakeBookmarks() {
	return {
		forUser: (userId) => (String(userId) === '42'
			? [{ workId: 'old-id/glass-road', finished: true, finishedAt: 1760000000000 }, { workId: 'b/second', finished: false }]
			: []),
	};
}

module.exports = { buildLibrary, fakeLongForm, fakeCatalog, fakeBookmarks, BOOK_ALBUM };
