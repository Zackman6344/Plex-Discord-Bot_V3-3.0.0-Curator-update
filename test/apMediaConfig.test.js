// helpers/configStore.js and config/config.js: the Plex Media world's settings, the AP Media group.
//
// What has to hold: every apMedia* setting has a default (a setting without one reads undefined
// until somebody saves it) and a row in its own /config group; none is named archipelago*, which
// would make every save re-apply the Archipelago monitor; the rows enforce the ranges the watcher
// relies on; and the /config panel, one embed listing every setting, stays inside Discord's
// 6,000-character embed total, past which Discord refuses the whole panel.
//
// Harness: the real configStore and config.js. The default values are compared only when there is
// no data/config.overrides.json (as test/configStore.test.js does), since a real one overrides them.
// The panel is rebuilt the way commands/config.js builds it, its fixed strings read from that file
// so a change there is measured too, and sized with discord.js's own embedLength.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, embedLength } = require('discord.js');

const store = require('../helpers/configStore.js');
const config = require('../config/config.js');
const contracts = require('../helpers/apMediaContracts.js');

const GROUP = 'AP Media';
const KEYS = Object.keys(contracts.SETTINGS);
const OVERRIDES = path.join(__dirname, '..', 'data', 'config.overrides.json');
const DISCORD_EMBED_MAX = 6000;
const CONFIG_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'commands', 'config.js'), 'utf8');

function sourceString(pattern, what) {
	const m = pattern.exec(CONFIG_SOURCE);
	assert.ok(m, `commands/config.js no longer has the ${what} this test measures; update the test`);
	return m[1].replace(/\\'/g, "'");
}

// Each setting at its longest rendering, as test/configStore.test.js picks it.
function worstCaseValues(settings = store.SETTINGS) {
	const long = 'x'.repeat(200);
	return Object.fromEntries(settings.map((s) => {
		const candidates = [true, false, '', long, Number.MAX_SAFE_INTEGER, ...(s.choices || []).map((c) => c.value)];
		const longest = candidates.reduce((best, v) =>
			store.formatValue(s, v).length > store.formatValue(s, best).length ? v : best);
		return [s.key, longest];
	}));
}

test('every apMedia setting has a default and a row in the AP Media group', () => {
	assert.ok(store.GROUPS.includes(GROUP), 'the group is in the panel order');
	const rows = store.settingsInGroup(GROUP).map((s) => s.key);
	assert.deepStrictEqual([...rows].sort(), [...KEYS].sort(), 'the group holds exactly the apMedia settings');
	for (const key of KEYS) {
		assert.ok(Object.prototype.hasOwnProperty.call(config, key), `${key} has no default in config/config.js`);
		assert.ok(store.getSetting(key), `${key} has no /config row`);
	}
	if (!fs.existsSync(OVERRIDES)) {
		for (const key of KEYS) assert.deepStrictEqual(config[key], contracts.SETTINGS[key].default, `${key} default`);
	}
});

test('no Plex Media setting is named archipelago*, and the group holds nothing else', () => {
	for (const key of KEYS) assert.ok(!key.startsWith('archipelago'), key);
	for (const s of store.settingsInGroup(GROUP)) assert.ok(s.key.startsWith('apMedia'), `${s.key} does not belong in ${GROUP}`);
	for (const s of store.SETTINGS) {
		if (s.key.startsWith('apMedia')) assert.strictEqual(s.group, GROUP, `${s.key} sits in ${s.group}`);
	}
});

test('the rows check what the watcher and the announcer rely on', () => {
	const get = (key) => store.getSetting(key);
	assert.strictEqual(get('apMediaEnabled').type, 'bool');
	assert.strictEqual(get('apMediaVoiceCredit').type, 'bool');

	const channel = get('apMediaChannelId');
	assert.deepStrictEqual(store.validate(channel, ''), { value: '' }, 'blank means the watch\'s own channel');
	assert.ok(store.validate(channel, 'general').error);
	assert.deepStrictEqual(store.validate(channel, '123456789012345678'), { value: '123456789012345678' });

	const history = get('apMediaHistorySeconds');
	assert.ok(store.validate(history, '29').error);
	assert.deepStrictEqual(store.validate(history, '30'), { value: 30 });
	assert.deepStrictEqual(store.validate(history, '86400'), { value: 86400 });
	assert.ok(store.validate(history, '86401').error, 'a day at most');

	const session = get('apMediaSessionSeconds');
	assert.ok(store.validate(session, '4').error);
	assert.deepStrictEqual(store.validate(session, '5'), { value: 5 });
	assert.ok(store.validate(session, '86401').error);

	const announce = get('apMediaAnnounce');
	assert.deepStrictEqual(announce.choices.map((c) => c.value), [...contracts.SETTINGS.apMediaAnnounce.values]);
	assert.ok(store.validate(announce, 'loud').error);
	assert.deepStrictEqual(store.validate(announce, 'all'), { value: 'all' });
});

test('the trap switches: traps and voice traps on by default, the clips playlist blank, each a row of its own', () => {
	const get = (key) => store.getSetting(key);
	assert.deepStrictEqual(
		[contracts.SETTINGS.apMediaTraps.default, contracts.SETTINGS.apMediaVoiceTraps.default, contracts.SETTINGS.apMediaTrapClips.default],
		[true, true, ''],
	);
	assert.strictEqual(get('apMediaTraps').type, 'bool');
	assert.strictEqual(get('apMediaVoiceTraps').type, 'bool');
	assert.match(get('apMediaVoiceTraps').warn, /everyone in the bot's voice channel/, 'the room hears them');
	const clips = get('apMediaTrapClips');
	assert.strictEqual(clips.type, 'string');
	assert.deepStrictEqual(store.validate(clips, ''), { value: '' }, 'blank: a 30 s pause instead');
	assert.deepStrictEqual(store.validate(clips, ' Commercials '), { value: 'Commercials' });
	assert.deepStrictEqual(store.validate(clips, '12345'), { value: '12345' }, 'a ratingKey');
	assert.ok(store.validate(clips, 'x'.repeat(201)).error);
});

test('the group fits one settings menu', () => {
	const pages = store.selectPages(GROUP);
	assert.strictEqual(pages.length, 1);
	assert.ok(pages[0].settings.length <= store.SELECT_OPTION_LIMIT);
});

// commands/config.js shows a status line above the panel: a save's confirmation (with any restart
// note and warning), a toggle or choice prompt, or an error. The longest of them is the worst case.
function longestStatusLine(values) {
	const lines = [];
	for (const s of store.SETTINGS) {
		let confirm = `\u2705 **${s.label}** updated.`;
		if (s.restartRequired) confirm += ' \u26A0\uFE0F Applies after the next restart.';
		if (s.warn) confirm += `\n\u26A0\uFE0F ${s.warn}`;
		lines.push(confirm);
		lines.push(`Toggle **${s.label}** (now ${store.formatValue(s, values[s.key])}):`);
		lines.push(`Choose a value for **${s.label}**:`);
	}
	return lines.reduce((a, b) => (b.length > a.length ? b : a));
}

test('the worst-case /config panel embed stays inside Discord\'s 6,000 characters', () => {
	const title = sourceString(/setTitle\('([^']*)'\)/, 'panel title');
	const footer = sourceString(/setFooter\(\{ text: '((?:[^'\\]|\\.)*)' \}\)/, 'panel footer');
	const owner = sourceString(/desc \+= '((?:[^'\\]|\\.)*)';\s*\}/, 'no-owner warning');
	const pick = sourceString(/desc \+= '(Pick a setting[^']*)'/, 'pick prompt');
	const values = worstCaseValues();
	const description = `${longestStatusLine(values)}\n\n${owner.replace(/\\n/g, '\n')}${pick}`;
	const embed = new EmbedBuilder()
		.setTitle(title)
		.setDescription(description)
		.addFields(store.panelFields(values))
		.setFooter({ text: footer });
	const total = embedLength(embed.data);
	assert.ok(total <= DISCORD_EMBED_MAX, `the panel is ${total} characters`);

	const field = store.panelFields(values).find((f) => f.name === GROUP);
	assert.ok(field, 'the group has its own field');
	assert.ok(field.value.length <= 1024);
	assert.strictEqual(field.value.split('\n').length, KEYS.length);
});
