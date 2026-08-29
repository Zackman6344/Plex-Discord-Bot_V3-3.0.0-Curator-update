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

// The panel renders one select per page plus a button row. Discord rejects a select with more
// than 25 options and a message with more than 5 action rows, and it rejects the whole payload
// rather than trimming, so overflowing either limit takes /config down entirely.
test('selectPages keeps every setting reachable exactly once', () => {
    const keys = store.selectPages().flatMap((page) => page.settings.map((s) => s.key));
    assert.strictEqual(keys.length, store.SETTINGS.length);
    assert.strictEqual(new Set(keys).size, store.SETTINGS.length);
    for (const setting of store.SETTINGS) {
        assert.ok(keys.includes(setting.key), `${setting.key} is unreachable in the panel`);
    }
});

test('selectPages fits Discord\'s select and action-row limits', () => {
    const pages = store.selectPages();
    assert.ok(pages.length <= store.SELECT_ROW_LIMIT, `${pages.length} menus exceeds the row budget`);
    for (const page of pages) {
        assert.ok(page.settings.length <= store.SELECT_OPTION_LIMIT, `menu "${page.label}" has ${page.settings.length} options`);
    }
});

test('selectPages gives each group its own menu while they fit', () => {
    const labels = store.selectPages().map((page) => page.label);
    assert.deepStrictEqual(labels, store.GROUPS.filter((g) => store.SETTINGS.some((s) => s.group === g)));
});

test('selectPages still respects both limits when the settings list outgrows them', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
        key: `synthetic${i}`,
        label: `Synthetic ${i}`,
        group: store.GROUPS[i % store.GROUPS.length],
        type: 'bool'
    }));
    const pages = store.selectPages(many);
    assert.ok(pages.length <= store.SELECT_ROW_LIMIT);
    for (const page of pages) {
        assert.ok(page.settings.length <= store.SELECT_OPTION_LIMIT);
    }
});
