// helpers/bookCard.js: the audiobook card rendered from the engine's view, in every state.
//
// The bug: a card Discord refuses (a sixth button in a row, a customId over 100 chars, an embed
// over its limits), so the edit fails and the card freezes; a "Mark finished" button offered far
// from the end, which ends a 37-hour book 11 minutes early; a sleep button that steps from the
// remaining minutes instead of the chosen ones; a title with * or _ that turns the card into
// italics soup; a ping from the listener mention. A chapter line that counts files: "Chapter 240
// of 319" on an omnibus whose track says Book 4, Chapter 7.
//
// Harness: pure, no Discord. Views are built by hand in the shape bookEngine.js view() returns,
// with nearEnd taken from bookModel.nearEnd so the 120 s rule is the real one.

const test = require('node:test');
const assert = require('node:assert');

const bookCard = require('../helpers/bookCard.js');
const bookModel = require('../helpers/bookModel.js');
const { chapterLabel } = require('../helpers/bookChapterLabel.js');

const T0 = 1791500000000;
const USER = '100000000000000001';
const WORK = {
	id: 'avery-quill/the-ember-throne',
	parts: [{ durationMs: 3900000 }, { durationMs: 3900000 }, { durationMs: 3900000 }, { durationMs: 3180000 }]
};

function view(over = {}) {
	const total = bookModel.totalMs(WORK);
	const pos = over.positionMs !== undefined ? over.positionMs : 5400000;
	return Object.assign({
		sessionId: 'a1b2c3',
		guildId: '200000000000000001',
		userId: USER,
		workId: WORK.id,
		listener: { id: USER, name: 'Ana', mention: `<@${USER}>` },
		title: 'The Ember Throne',
		author: 'Avery Quill',
		series: 'Ashfall',
		sequence: 1,
		narrator: 'Mara Lindqvist',
		edition: null,
		kind: 'book',
		state: 'playing',
		buffering: false,
		positionMs: pos,
		totalMs: total,
		fraction: pos / total,
		remainingMs: total - pos,
		remainingAtSpeedMs: (total - pos) / 1.25,
		chapter: { index: 2, count: 4, title: 'Part 2', label: 'Part 2 of 4', short: 'Part 2 of 4', detail: null, startMs: 3900000, endMs: 7800000, endsAt: T0 + 600000 },
		partIndex: 1,
		partCount: 4,
		speed: 1.25,
		sleep: null,
		paused: null,
		queuedMusicCount: 0,
		voiceChannel: { id: '300000000000000001', name: 'Lounge' },
		saveHealthy: true,
		nearEnd: bookModel.nearEnd(WORK, pos),
		endReason: null,
		endDetail: null,
		finished: null
	}, over);
}

function buttons(payload) {
	return payload.components.flatMap(r => r.components);
}

function ids(payload) {
	return buttons(payload).map(b => b.custom_id);
}

function assertDiscordShape(payload, where) {
	assert.ok(payload.components.length <= 5, `${where}: at most 5 rows`);
	for (const r of payload.components) {
		assert.strictEqual(r.type, 1, `${where}: rows are action rows`);
		assert.ok(r.components.length >= 1 && r.components.length <= 5, `${where}: 1 to 5 buttons per row`);
		for (const b of r.components) {
			assert.strictEqual(b.type, 2);
			assert.ok(b.custom_id.startsWith('book:'), `${where}: ${b.custom_id} is in the book namespace`);
			assert.ok(b.custom_id.length <= 100, `${where}: ${b.custom_id} over 100 chars`);
			assert.ok(b.label.length >= 1 && b.label.length <= 80, `${where}: label length`);
		}
	}
	const all = ids(payload);
	assert.strictEqual(new Set(all).size, all.length, `${where}: customIds are unique`);
	for (const e of payload.embeds) {
		assert.ok(!e.title || e.title.length <= 256, `${where}: title`);
		assert.ok(!e.description || e.description.length <= 4096, `${where}: description`);
		assert.ok(!e.footer || e.footer.text.length <= 2048, `${where}: footer`);
		const total = (e.title || '').length + (e.description || '').length + (e.footer ? e.footer.text.length : 0);
		assert.ok(total <= 6000, `${where}: embed total ${total}`);
	}
	assert.deepStrictEqual(payload.allowedMentions, { parse: [] }, `${where}: never pings`);
}

test('the playing card has two rows of controls, every id carrying the session', () => {
	const p = bookCard.buildCard(view());
	assertDiscordShape(p, 'playing');
	assert.strictEqual(p.components.length, 2);
	assert.deepStrictEqual(ids(p), [
		'book:prevch:a1b2c3', 'book:back:a1b2c3', 'book:toggle:a1b2c3', 'book:fwd:a1b2c3', 'book:nextch:a1b2c3',
		'book:speed:a1b2c3', 'book:sleep:a1b2c3', 'book:stop:a1b2c3'
	]);
	const toggle = buttons(p).find(b => b.custom_id.startsWith('book:toggle:'));
	assert.strictEqual(toggle.label, 'Pause');
	assert.strictEqual(buttons(p).find(b => b.custom_id.startsWith('book:stop:')).style, 4, 'Stop is red');
	assert.strictEqual(buttons(p).find(b => b.custom_id.startsWith('book:speed:')).label, '1.25x');
	const d = p.embeds[0].description;
	assert.match(d, /\*\*Part 2 of 4\*\*\n/);
	assert.match(d, /1:30:00 \/ 4:08:00 · 2 h 06 m left at 1\.25x/);
	assert.match(d, new RegExp(`Chapter ends <t:${Math.round((T0 + 600000) / 1000)}:R>`));
	assert.match(d, new RegExp(`🎧 <@${USER}> in 🔊 Lounge`), 'the listener is a mention, sent with no pings');
	assert.match(p.embeds[0].footer.text, /Ana's book · 1\.25x · your place saves itself/);
});

test('the paused card offers Resume and says when the bot leaves voice', () => {
	const p = bookCard.buildCard(view({ state: 'paused', paused: { at: T0, leaveAt: T0 + 600000, reason: 'paused', detail: null } }));
	assertDiscordShape(p, 'paused');
	const toggle = buttons(p).find(b => b.custom_id.startsWith('book:toggle:'));
	assert.strictEqual(toggle.label, 'Resume');
	assert.strictEqual(toggle.emoji.name, '▶️');
	assert.match(p.embeds[0].description, new RegExp(`⏸ Paused <t:${T0 / 1000}:R> · I'll leave voice <t:${(T0 + 600000) / 1000}:R> if nobody resumes`));
	assert.doesNotMatch(p.embeds[0].description, /Chapter ends/, 'no countdown while nothing plays');
});

test('each pause reason gets its own line, with the engine detail for file and Plex failures', () => {
	const cases = [
		['listener-left', null, /Ana left the voice channel/],
		['unsubscribed', null, /Something else took over the voice connection/],
		['plex-failing', 'Plex stopped sending audio 3 times in 2 minutes. Paused at 1:30:00.', /⚠️ Plex stopped sending audio 3 times/],
		['file-ends-early', 'The file for Part 2 ends early at 12:00. Your place is saved.', /⚠️ The file for Part 2 ends early at 12:00/]
	];
	for (const [reason, detail, re] of cases) {
		const p = bookCard.buildCard(view({ state: 'paused', paused: { at: T0, leaveAt: T0 + 1000, reason, detail } }));
		assert.match(p.embeds[0].description, re, reason);
	}
});

test('a starting card disables the controls but keeps Stop', () => {
	const p = bookCard.buildCard(view({ state: 'starting', chapter: null }));
	assertDiscordShape(p, 'starting');
	for (const b of buttons(p)) {
		if (b.custom_id.startsWith('book:stop:')) assert.ok(!b.disabled);
		else assert.strictEqual(b.disabled, true, b.custom_id);
	}
	assert.match(p.embeds[0].description, /Joining the voice channel/);
});

test('the sleep button shows the minutes chosen, not the minutes left', () => {
	// bookModel.nextSleep steps from `minutes`; a label from the remainder would say 12 and the
	// next click would jump to 15 instead of 60.
	const timer = bookCard.buildCard(view({ sleep: { mode: 'timer', minutes: 30, remainingMs: 12 * 60000, endsAt: T0 + 12 * 60000 } }));
	assert.strictEqual(buttons(timer).find(b => b.custom_id.startsWith('book:sleep:')).label, 'Sleep: 30 min');
	assert.match(timer.embeds[0].description, new RegExp(`🌙 Sleep <t:${(T0 + 12 * 60000) / 1000}:R>`));
	const parked = bookCard.buildCard(view({ sleep: { mode: 'timer', minutes: 30, remainingMs: 12 * 60000, endsAt: null } }));
	assert.match(parked.embeds[0].description, /🌙 Sleep after 12 min more listening/, 'no countdown while it is not counting');
	const chapter = bookCard.buildCard(view({ sleep: { mode: 'chapter' } }));
	assert.strictEqual(buttons(chapter).find(b => b.custom_id.startsWith('book:sleep:')).label, 'Sleep: chapter');
	const off = bookCard.buildCard(view());
	assert.strictEqual(buttons(off).find(b => b.custom_id.startsWith('book:sleep:')).label, 'Sleep: off');
});

test('queued music and a failing save each get a line', () => {
	const p = bookCard.buildCard(view({ queuedMusicCount: 3, saveHealthy: false }));
	assert.match(p.embeds[0].description, /🎵 3 music tracks waiting \(they play after \/book stop\)/);
	assert.match(p.embeds[0].description, /⚠️ Your place could not be written to disk/);
	const one = bookCard.buildCard(view({ queuedMusicCount: 1 }));
	assert.match(one.embeds[0].description, /1 music track waiting/);
	assert.doesNotMatch(bookCard.buildCard(view()).embeds[0].description, /music track|could not be written/);
});

test('mark finished appears only within 120 s of the end', () => {
	const total = bookModel.totalMs(WORK);
	const at119 = bookCard.endedCard(view({ state: 'ended', endReason: 'explicit', positionMs: total - 119000, nearEnd: bookModel.nearEnd(WORK, total - 119000) }));
	const at121 = bookCard.endedCard(view({ state: 'ended', endReason: 'explicit', positionMs: total - 121000, nearEnd: bookModel.nearEnd(WORK, total - 121000) }));
	assert.ok(ids(at119).includes(`book:finish:${WORK.id}:${USER}`), 'offered at 119 s, for this listener only');
	assert.ok(!ids(at121).some(id => id.startsWith('book:finish:')), 'not at 121 s');
	assertDiscordShape(at119, 'ended near the end');
	const done = bookCard.endedCard(view({ state: 'ended', endReason: 'finished', positionMs: total, nearEnd: true, finished: { totalMs: total, startedAt: T0 - 3 * 86400000, finishedAt: T0, days: 3 } }));
	assert.ok(!ids(done).some(id => id.startsWith('book:finish:')), 'a finished work is not offered again');
	assert.match(done.embeds[0].description, /🎉 Finished The Ember Throne in 3 days/);
	assert.strictEqual(buttons(done).find(b => b.custom_id.startsWith('book:resume:')).label, 'Listen again');
});

test('the ended card names the reason and where the place was saved', () => {
	const reasons = {
		explicit: /⏹ Stopped/, generic: /⏹ Stopped/, sleep: /😴 Sleep timer/, idle: /💤 Left voice/,
		'voice-lost': /🔌 Lost the voice connection/, shutdown: /🔄 The bot restarted/,
		switched: /🔀 Switched to another book/, 'join-failed': /Couldn't join/, forgotten: /🗑 Bookmark forgotten/
	};
	for (const [reason, re] of Object.entries(reasons)) {
		const p = bookCard.endedCard(view({ state: 'ended', endReason: reason }));
		assertDiscordShape(p, reason);
		assert.match(p.embeds[0].description, re, reason);
		assert.ok(ids(p).includes('book:shelf'), `${reason}: My shelf`);
		if (reason === 'forgotten') {
			assert.ok(!ids(p).some(id => id.startsWith('book:resume:')), 'nothing to resume');
			assert.doesNotMatch(p.embeds[0].description, /Saved at/);
		} else {
			assert.ok(ids(p).includes(`book:resume:${WORK.id}`), `${reason}: Resume`);
			assert.match(p.embeds[0].description, /Saved at 1:30:00 \(Part 2 of 4\) of 4:08:00\./);
		}
	}
	const failed = bookCard.endedCard(view({ state: 'ended', endReason: 'failed-file', endDetail: 'Plex can\'t find the file for Ch 2 (it may have moved). Your place is saved; try again in a minute.' }));
	assert.match(failed.embeds[0].description, /⚠️ Plex can't find the file for Ch 2/);
});

test('titles are escaped and nothing overflows Discord limits', () => {
	const long = 'The *Very* _Long_ `Title` ~of~ |Doom| '.repeat(12);
	const detail = 'x'.repeat(5000);
	const states = [
		view({ title: long, author: long, series: long }),
		view({ title: long, state: 'paused', paused: { at: T0, leaveAt: T0, reason: 'file-ends-early', detail } }),
		view({ title: long, state: 'starting' }),
		view({ title: long, state: 'ended', endReason: 'failed-file', endDetail: detail }),
		view({ title: long, state: 'ended', endReason: 'explicit', listener: { id: USER, name: 'n'.repeat(3000), mention: `<@${USER}>` } })
	];
	for (const v of states) {
		const p = v.state === 'ended' ? bookCard.endedCard(v) : bookCard.buildCard(v);
		assertDiscordShape(p, v.state);
	}
	const d = bookCard.buildCard(view({ title: 'A *b* _c_' })).embeds[0];
	assert.strictEqual(d.title, '📚 A \\*b\\* \\_c\\_');
});

test('a button whose id would pass 100 chars is left off instead of breaking the card', () => {
	const workId = `${'a'.repeat(60)}/${'b'.repeat(40)}`;
	const p = bookCard.endedCard(view({ state: 'ended', endReason: 'explicit', workId, nearEnd: true }));
	assertDiscordShape(p, 'long work id');
	assert.ok(!ids(p).some(id => id.startsWith('book:resume:') || id.startsWith('book:finish:')));
	assert.ok(ids(p).includes('book:shelf'));
});

test('the moved card has no buttons', () => {
	const p = bookCard.movedCard();
	assert.deepStrictEqual(p.components, []);
	assert.deepStrictEqual(p.embeds, []);
	assert.match(p.content, /moved/);
});

test('marking finished drops only that button and says so', () => {
	const ended = bookCard.endedCard(view({ state: 'ended', endReason: 'explicit', nearEnd: true }));
	// discord.js hands back Embed and ActionRow objects; toJSON gives the raw shape.
	const message = {
		embeds: ended.embeds.map(e => ({ toJSON: () => JSON.parse(JSON.stringify(e)) })),
		components: ended.components.map(r => ({ toJSON: () => JSON.parse(JSON.stringify(r)) }))
	};
	const p = bookCard.finishedOnCard(message);
	assert.deepStrictEqual(ids(p), [`book:resume:${WORK.id}`, 'book:shelf']);
	assert.match(p.embeds[0].description, /🎉 Marked finished\.$/);
	assert.match(p.embeds[0].description, /⏹ Stopped/, 'the rest of the card is kept');
	assert.deepStrictEqual(bookCard.finishedOnCard({}), { embeds: [], components: [], allowedMentions: { parse: [] } });
});

// ---- the chapter line ----------------------------------------------------------------------------

const OMNIBUS = {
	id: 'avery-quill/the-iron-crowns',
	kind: 'book',
	title: 'The Iron Crowns',
	parts: [
		'1-01 Book 1  The Salt Road - Intro',
		'1-02 Book 1  The Salt Road - Chapter 01a',
		'4-09 Book 4  The *Lantern* Hour - Chapter 07a'
	].map((title, i) => ({ ordinal: i + 1, title, durationMs: 600000 }))
};

function omnibusView(i, over = {}) {
	const chs = bookModel.chapters(OMNIBUS);
	const l = chapterLabel(OMNIBUS, chs[i], chs);
	return view(Object.assign({
		chapter: { index: chs[i].number, count: chs.length, title: chs[i].title, label: l.label, short: l.short, detail: l.detail, startMs: chs[i].startMs, endMs: chs[i].endMs, endsAt: null }
	}, over));
}

test('the card names the book and chapter the track names, bold, with the book title after it', () => {
	const d = bookCard.buildCard(omnibusView(2)).embeds[0].description;
	assert.match(d, /\*\*Book 4 · Chapter 7\*\* · The \\\*Lantern\\\* Hour\n/, 'the title is escaped, the label bold');
	assert.doesNotMatch(d, /Chapter 3 of 3|4-09/, 'neither the file count nor the raw track title');
	assert.match(bookCard.buildCard(omnibusView(0)).embeds[0].description, /\*\*Book 1\*\* · The Salt Road\n/);
});

test('the ended card saves at the label without its title', () => {
	const p = bookCard.endedCard(omnibusView(2, { state: 'ended', endReason: 'explicit' }));
	assert.match(p.embeds[0].description, /Saved at 1:30:00 \(Book 4 · Chapter 7\) of 4:08:00\./);
});

test('a view without a label keeps the slot numbers', () => {
	const bare = { index: 2, count: 4, title: 'Part 2', startMs: 3900000, endMs: 7800000, endsAt: null };
	assert.match(bookCard.buildCard(view({ chapter: bare })).embeds[0].description, /\*\*Chapter 2 of 4\*\* · Part 2/);
	assert.match(bookCard.endedCard(view({ chapter: bare, state: 'ended', endReason: 'explicit' })).embeds[0].description, /\(Ch 2 of 4\)/);
});

// ---- the read-along's 📖 -----------------------------------------------------------------------

test('📖 joins the settings row only when the read-along says there is text, and never on the ended card', () => {
	assert.ok(!ids(bookCard.buildCard(view())).some(id => id.startsWith('bookread:')), 'no text info: no button');
	assert.ok(!ids(bookCard.buildCard(view({ text: { button: false } }))).some(id => id.startsWith('bookread:')));
	const p = bookCard.buildCard(view({ text: { button: true } }));
	const settings = p.components[1].components;
	assert.ok(settings.length <= 5);
	assert.deepStrictEqual(settings.map(b => b.custom_id), ['book:speed:a1b2c3', 'book:sleep:a1b2c3', 'bookread:a1b2c3', 'book:stop:a1b2c3']);
	const read = settings[2];
	assert.strictEqual(read.label, 'Text');
	assert.deepStrictEqual(read.emoji, { name: '📖' });
	assert.strictEqual(bookCard.buildCard(view({ text: { button: true }, state: 'starting' })).components[1].components[2].disabled, true, 'disabled while joining, like the rest');
	const ended = bookCard.endedCard(view({ text: { button: true }, state: 'ended', endReason: 'explicit' }));
	assert.ok(!ids(ended).some(id => id.startsWith('bookread:')));
	assert.ok(!JSON.stringify(p.embeds).includes('📖'), 'the card itself carries no read-along text');
});
