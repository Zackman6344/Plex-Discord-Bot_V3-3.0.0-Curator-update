// helpers/apMediaAutoskip.js: which queue entries the autoskip may skip, and the line and the
// command-log event for a stretch of skipped songs.
//
// What has to hold: only a Plex track about to play for the first time is ever offered to the check
// (never a secret clip, a YouTube entry, or a song a !seek or a Rewind is replaying, nor a !loop's
// once it has played; a !loop set on a song still waiting to play does not get it past); the line
// counts the songs, names three of them, says where they are locked ("in" a playlist, which need not
// be where the song was queued from), names each slot and playlist once and three of each at most,
// shows a title as typed (Markdown and masked links escaped, 100 characters at most) and a slot name
// in inline code that a backtick cannot end; and the event counts the songs, names the first 20, and
// each slot and playlist once.
//
// Harness: the module alone; it reads nothing but its arguments.

const test = require('node:test');
const assert = require('node:assert');

const { skippable, lineFor, eventFor } = require('../helpers/apMediaAutoskip.js');

const ICON = '\u23ED\uFE0F';
const ROAD = { slots: ['ZackPlex'], playlists: ['Road Trip'] };
const PARTY = { slots: ['Friend'], playlists: ['Party'] };
const song = (title, why = ROAD) => ({ title, artist: 'Artist', ...why });

test('only a Plex track about to play for the first time may be skipped', () => {
	const track = { title: 'Song A', artist: 'Artist A', key: '/library/parts/250011/1/file.flac' };
	assert.strictEqual(skippable(track), true);
	assert.strictEqual(skippable({ ...track, secret: true }), false, 'a Hitster clip or a trap clip');
	assert.strictEqual(skippable({ title: 'A video', artist: 'Someone', url: 'https://youtu.be/x' }), false, 'a YouTube entry');
	assert.strictEqual(skippable({ ...track, key: '' }), false);
	assert.strictEqual(skippable({ ...track, replay: true, played: true }), false, 'a !loop replaying a song that has played');
	assert.strictEqual(skippable({ ...track, replay: true }), true, 'a !loop set on a song still waiting to play');
	assert.strictEqual(skippable({ ...track, played: true }), true, 'a song played before, queued again');
	assert.strictEqual(skippable({ ...track, isSeeking: true, seekOffset: 0 }), false, 'a !seek or a Rewind');
	assert.strictEqual(skippable(null), false);
	assert.strictEqual(skippable('Song A'), false);
});

test('the line counts the songs, names three of them, and says where they are locked', () => {
	assert.strictEqual(
		lineFor([song('A'), song('B'), song('C'), song('D')]),
		`${ICON} Skipped 4 songs still locked in Road Trip on \`ZackPlex\`'s list: **A**, **B**, **C** and 1 more.`
	);
	assert.strictEqual(lineFor([song('Song A')]), `${ICON} Skipped 1 song still locked in Road Trip on \`ZackPlex\`'s list: **Song A**.`);
	assert.strictEqual(
		lineFor([song('A'), song('B', { slots: ['Friend', 'ZackPlex'], playlists: ['Party', 'Road Trip'] })]),
		`${ICON} Skipped 2 songs still locked in Road Trip and Party on the lists of \`ZackPlex\` and \`Friend\`: **A** and **B**.`,
		'each slot and playlist once, in the order they came'
	);
	assert.strictEqual(
		lineFor([song('A'), song('B'), song('C')]),
		`${ICON} Skipped 3 songs still locked in Road Trip on \`ZackPlex\`'s list: **A**, **B** and **C**.`
	);
});

test('the line names three slots and three playlists at most, and counts the rest', () => {
	const reasons = [
		{ slots: ['A', 'B'], playlists: ['P1', 'P2'] },
		{ slots: ['C', 'D'], playlists: ['P3', 'P4'] },
		{ slots: ['E'], playlists: ['P5'] },
	];
	assert.strictEqual(
		lineFor(reasons),
		`${ICON} Skipped 3 songs still locked in P1, P2, P3 and 2 more playlists on the lists of \`A\`, \`B\`, \`C\` and 2 more.`
	);
	assert.strictEqual(
		lineFor([{ title: 'X', slots: ['A', 'B', 'C'], playlists: ['P1', 'P2', 'P3', 'P4'] }]),
		`${ICON} Skipped 1 song still locked in P1, P2, P3 and 1 more playlist on the lists of \`A\`, \`B\` and \`C\`: **X**.`
	);
});

test('a title shows as typed, cut at 100 characters, and a slot name keeps to its code span', () => {
	const line = lineFor([{ title: '**Hot** [Take](https://example.com)', slots: ['Zack`Plex'], playlists: ['**Loud** [Mix](https://example.com) _now_'] }]);
	assert.strictEqual(
		line,
		`${ICON} Skipped 1 song still locked in \\*\\*Loud\\*\\* \\[Mix](https://example.com) \\_now\\_ on \`Zack'Plex\`'s list: **\\*\\*Hot\\*\\* \\[Take](https://example.com)**.`,
		'an escaped [ is enough to keep a masked link from working'
	);
	const long = lineFor([{ title: 'y'.repeat(1000), slots: ['ZackPlex'], playlists: ['x'.repeat(1000)] }]);
	assert.ok(long.includes(` in ${'x'.repeat(99)}\u2026 on `), long);
	assert.ok(long.includes(`: **${'y'.repeat(99)}\u2026**.`), long);
	assert.ok(long.length < 300);
	assert.strictEqual(lineFor([song('Two\nLines ')]), `${ICON} Skipped 1 song still locked in Road Trip on \`ZackPlex\`'s list: **Two Lines**.`);
});

test('a skip with nothing to name still makes a line, and odd values are left out', () => {
	assert.strictEqual(lineFor([{}]), `${ICON} Skipped 1 locked song.`);
	assert.strictEqual(lineFor([{ title: 'B' }]), `${ICON} Skipped 1 locked song: **B**.`);
	assert.strictEqual(lineFor([{ title: 'B', playlists: ['Road Trip'] }]), `${ICON} Skipped 1 song still locked in Road Trip: **B**.`);
	assert.strictEqual(lineFor([{ slots: ['', null, 'ZackPlex'], playlists: 'Road Trip', title: '  ' }, null]),
		`${ICON} Skipped 2 songs still locked on \`ZackPlex\`'s list.`);
	assert.strictEqual(lineFor([song('A'), { title: 7 }]), `${ICON} Skipped 2 songs still locked in Road Trip on \`ZackPlex\`'s list: **A** and 1 more.`);
	assert.strictEqual(
		lineFor([song('A'), song(''), song('B'), song('C'), song('D')]),
		`${ICON} Skipped 5 songs still locked in Road Trip on \`ZackPlex\`'s list: **A**, **B**, **C** and 2 more.`,
		'three named, and the rest counted, titled or not'
	);
});

test('the event counts the stretch, names its first 20 songs, and each slot and playlist once', () => {
	assert.deepStrictEqual(eventFor([song('A'), song('B', PARTY), song('C')]), {
		count: 3,
		songs: 'Artist - A; Artist - B; Artist - C',
		slots: 'ZackPlex, Friend',
		playlists: 'Road Trip, Party',
	});
	const long = eventFor(Array.from({ length: 600 }, (_, i) => song(`L${i}`)));
	assert.strictEqual(long.count, 600);
	assert.strictEqual(long.songs.split('; ').length, 20);
	assert.ok(long.songs.startsWith('Artist - L0; Artist - L1;'), long.songs);
	assert.deepStrictEqual(eventFor([{ title: 'B' }, { artist: 'Only Artist' }, {}, null]), { count: 4, songs: 'B; Only Artist', slots: '', playlists: '' });
});
