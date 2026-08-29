const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
