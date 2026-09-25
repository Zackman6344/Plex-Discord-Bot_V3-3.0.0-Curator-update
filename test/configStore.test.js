const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EmbedBuilder } = require('discord.js');

const store = require('../helpers/configStore.js');

function tmpFile() {
    return path.join(os.tmpdir(), `cfg-overrides-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('writeOverride + readOverrides roundtrip (file-only, no live mutation)', () => {
    const p = tmpFile();
    try {
        store.writeOverride('serverName', 'Test Server', { path: p, applyLive: false });
        store.writeOverride('eventServerPort', 9001, { path: p, applyLive: false });
        const obj = store.readOverrides(p);
        assert.strictEqual(obj.serverName, 'Test Server');
        assert.strictEqual(obj.eventServerPort, 9001);
    } finally {
        fs.rmSync(p, { force: true });
    }
});

test('removeOverride drops a key from the file', () => {
    const p = tmpFile();
    try {
        store.writeOverride('serverName', 'X', { path: p, applyLive: false });
        store.removeOverride('serverName', { path: p });
        assert.ok(!Object.prototype.hasOwnProperty.call(store.readOverrides(p), 'serverName'));
    } finally {
        fs.rmSync(p, { force: true });
    }
});

test('readOverrides returns {} for a missing or malformed file', () => {
    assert.deepStrictEqual(store.readOverrides(tmpFile()), {});
    const p = tmpFile();
    try {
        fs.writeFileSync(p, '{ not valid json');
        assert.deepStrictEqual(store.readOverrides(p), {});
    } finally {
        fs.rmSync(p, { force: true });
    }
});

test('validate: int respects range and rejects non-numbers', () => {
    const port = store.getSetting('eventServerPort');
    assert.strictEqual(store.validate(port, '8799').value, 8799);
    assert.ok(store.validate(port, '0').error);
    assert.ok(store.validate(port, '70000').error);
    assert.ok(store.validate(port, 'abc').error);
});

test('validate: snowflake string requires 17-20 digits but allows blank', () => {
    const owner = store.getSetting('ownerId');
    assert.strictEqual(store.validate(owner, '123456789012345678').value, '123456789012345678');
    assert.ok(store.validate(owner, '123').error);
    assert.strictEqual(store.validate(owner, '   ').value, ''); // blank allowed → empty
});

test('validate: allowEmpty:false rejects blank (commandPrefix)', () => {
    const prefix = store.getSetting('commandPrefix');
    assert.ok(store.validate(prefix, '').error);
    assert.strictEqual(store.validate(prefix, '!').value, '!');
});

test('validate: choice only accepts listed values', () => {
    const q = store.getSetting('youtube_quality');
    assert.strictEqual(store.validate(q, 'highestaudio').value, 'highestaudio');
    assert.ok(store.validate(q, 'medium').error);
});

test('validate: tautulliUrl must be http(s)', () => {
    const url = store.getSetting('tautulliUrl');
    assert.strictEqual(store.validate(url, 'http://localhost:8181').value, 'http://localhost:8181');
    assert.ok(store.validate(url, 'localhost:8181').error);
});

test('formatValue masks secrets and renders bools/choices', () => {
    assert.strictEqual(store.formatValue(store.getSetting('eventServerToken'), 'hunter2'), '••• set');
    assert.strictEqual(store.formatValue(store.getSetting('eventServerToken'), ''), '— not set');
    assert.strictEqual(store.formatValue(store.getSetting('playniteEnabled'), true), '✅ enabled');
    assert.strictEqual(store.formatValue(store.getSetting('playniteEnabled'), false), '🚫 disabled');
    assert.strictEqual(store.formatValue(store.getSetting('youtube_quality'), 'lowestaudio'), 'Lowest (less bandwidth)');
    assert.strictEqual(store.formatValue(store.getSetting('listenChannel'), ''), '— (empty)');
});

// Discord rejects a select carrying more than 25 options, and a message carrying more than 5
// action rows, by refusing the whole payload rather than trimming it. Overflowing either takes
// /config down entirely, which is how the panel broke once at 26 settings.
test('every setting is reachable from some group', () => {
    const reachable = store.groupNames().flatMap((g) => store.settingsInGroup(g).map((s) => s.key));
    assert.strictEqual(new Set(reachable).size, store.SETTINGS.length);
    for (const setting of store.SETTINGS) {
        assert.ok(reachable.includes(setting.key), `${setting.key} is unreachable in the panel`);
    }
});

test('the group menu and every settings menu fit their limits', () => {
    const groups = store.groupNames();
    assert.ok(groups.length <= store.SELECT_OPTION_LIMIT, `${groups.length} groups exceeds one menu`);
    for (const group of groups) {
        const pages = store.selectPages(group);
        assert.ok(pages.length <= store.SETTING_ROW_LIMIT, `group "${group}" needs ${pages.length} rows`);
        for (const page of pages) {
            assert.ok(page.settings.length <= store.SELECT_OPTION_LIMIT, `menu "${page.label}" has ${page.settings.length} options`);
        }
    }
});

test('a group larger than one menu is split rather than truncated', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
        key: `synthetic${i}`, label: `Synthetic ${i}`, group: 'General', type: 'bool'
    }));
    const pages = store.selectPages('General', many);
    assert.strictEqual(pages.length, 3);
    assert.strictEqual(pages.flatMap((p) => p.settings).length, 60);
    for (const page of pages) assert.ok(page.settings.length <= store.SELECT_OPTION_LIMIT);
});

test('groupNames surfaces a group invented outside the GROUPS list', () => {
    const settings = [{ key: 'x', label: 'X', group: 'Nowhere', type: 'bool' }];
    assert.deepStrictEqual(store.groupNames(settings), ['Nowhere']);
});

test('the Archipelago section covers the room, its channel and its filters', () => {
    const keys = store.settingsInGroup('Archipelago').map((s) => s.key);
    for (const expected of [
        'archipelagoEnabled', 'archipelagoChannelId', 'archipelagoRoomUrl', 'archipelagoHost',
        'archipelagoPort', 'archipelagoSlot', 'archipelagoPassword', 'archipelagoBatchSeconds',
        'archipelagoProgressionOnly', 'archipelagoShowItems', 'archipelagoShowHints',
        'archipelagoShowChat', 'archipelagoShowJoins', 'archipelagoShowGoals',
        'archipelagoShowMisc', 'archipelagoShowDeaths'
    ]) {
        assert.ok(keys.includes(expected), `${expected} is missing from the Archipelago section`);
    }
    // The password must never be rendered back into the panel.
    assert.strictEqual(store.formatValue(store.getSetting('archipelagoPassword'), 'hunter2'), '••• set');
});

// discord.js throws on an embed field value over 1,024 characters rather than trimming it, which
// is how a long room URL, host and role name together took /config down. The assertions use
// Discord's number, not the module's own constant, so a wrong constant cannot pass itself.
const DISCORD_FIELD_VALUE_MAX = 1024;

// Picking each setting's longest rendering checks the panel at the most it can ever show.
function worstCaseValues(settings = store.SETTINGS) {
    const long = 'x'.repeat(200);
    return Object.fromEntries(settings.map((s) => {
        const candidates = [true, false, '', long, Number.MAX_SAFE_INTEGER, ...(s.choices || []).map((c) => c.value)];
        const longest = candidates.reduce((best, v) =>
            store.formatValue(s, v).length > store.formatValue(s, best).length ? v : best);
        return [s.key, longest];
    }));
}

test('no setting renders more than 60 characters of value, even an unknown choice', () => {
    for (const setting of store.SETTINGS) {
        const shown = store.formatValue(setting, worstCaseValues([setting])[setting.key]);
        assert.ok(shown.length <= 60, `${setting.key} renders ${shown.length} characters`);
    }
    assert.strictEqual(store.formatValue(store.getSetting('youtube_quality'), 'x'.repeat(200)).length, 60);
});

test('every panel field fits Discord\'s limit with every value at its longest', () => {
    const fields = store.panelFields(worstCaseValues());
    for (const field of fields) {
        assert.ok(field.value.length <= DISCORD_FIELD_VALUE_MAX, `"${field.name}" renders ${field.value.length} characters`);
    }
    // Splitting adds fields, and an embed carries 25 at most.
    assert.ok(fields.length <= 25, `${fields.length} fields exceeds one embed`);
    const lines = fields.flatMap((f) => f.value.split('\n'));
    assert.strictEqual(lines.length, store.SETTINGS.length);
});

test('discord.js accepts the worst-case panel fields', () => {
    assert.doesNotThrow(() => new EmbedBuilder().addFields(store.panelFields(worstCaseValues())));
});

test('a 60-character room URL, host and role name no longer break the panel', () => {
    const values = {
        archipelagoRoomUrl: 'u'.repeat(60),
        archipelagoHost: 'h'.repeat(60),
        archipelagoRoleName: 'n'.repeat(60),
    };
    const archipelago = store.panelFields(values).filter((f) => f.name.startsWith('Archipelago'));
    assert.ok(archipelago.length > 1, 'these three values alone should overflow one field, as they did in the report');
    assert.doesNotThrow(() => new EmbedBuilder().addFields(archipelago));
});

test('a group too long for one field splits between lines, keeping every line in order', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
        key: `synthetic${i}`, label: `Synthetic setting ${i}`, group: 'General', type: 'string'
    }));
    const values = Object.fromEntries(many.map((s) => [s.key, 'x'.repeat(60)]));
    const fields = store.panelFields(values, many);
    assert.ok(fields.length > 1);
    assert.deepStrictEqual(fields.map((f) => f.name), ['General', ...Array(fields.length - 1).fill('General (continued)')]);
    for (const field of fields) assert.ok(field.value.length <= DISCORD_FIELD_VALUE_MAX);
    const lines = fields.flatMap((f) => f.value.split('\n'));
    assert.strictEqual(lines.length, 40);
    lines.forEach((line, i) => assert.ok(line.startsWith(`**Synthetic setting ${i}:**`), line));
});

test('a single line longer than a whole field is cut rather than breaking the panel', () => {
    const settings = [
        { key: 'a', label: 'L'.repeat(2000), group: 'General', type: 'bool' },
        { key: 'b', label: 'Short', group: 'General', type: 'bool' },
    ];
    const fields = store.panelFields({ a: true, b: false }, settings);
    assert.strictEqual(fields.length, 2);
    assert.strictEqual(fields[0].value.length, DISCORD_FIELD_VALUE_MAX);
    assert.strictEqual(fields[1].value, '**Short:** 🚫 disabled');
    assert.doesNotThrow(() => new EmbedBuilder().addFields(fields));
});

// Two lines that fill a field exactly only when the newline between them is counted, so an
// off-by-one in the packing ships a 1,025-character field.
test('the newline between two lines counts toward the field limit', () => {
    // A bool line is its label plus 17 UTF-16 units: "**", ":** " and "🚫 disabled".
    const pair = (a, b) => [
        { key: 'a', label: 'A'.repeat(a - 17), group: 'General', type: 'bool' },
        { key: 'b', label: 'B'.repeat(b - 17), group: 'General', type: 'bool' },
    ];
    const fits = store.panelFields({}, pair(511, 512));
    assert.deepStrictEqual(fits.map((f) => f.value.length), [DISCORD_FIELD_VALUE_MAX]);
    const over = store.panelFields({}, pair(512, 512));
    assert.deepStrictEqual(over.map((f) => f.value.length), [512, 512]);
    assert.doesNotThrow(() => new EmbedBuilder().addFields(fits));
    assert.doesNotThrow(() => new EmbedBuilder().addFields(over));
});

// The group menu already lists a group invented outside GROUPS, so the embed has to as well.
test('the panel shows a group invented outside the GROUPS list, after the listed ones', () => {
    const settings = [
        { key: 'x', label: 'X', group: 'Nowhere', type: 'bool' },
        { key: 'a', label: 'A', group: 'General', type: 'bool' },
    ];
    assert.deepStrictEqual(store.panelFields({}, settings).map((f) => f.name), ['General', 'Nowhere']);
});
