// Parsing the multiworld tracker page. The fixture mirrors the real archipelago.gg markup,
// including the &percnt; header entity and a row whose slot is at 100% without having goaled,
// which is the case this whole feature exists for.

const test = require('node:test');
const assert = require('node:assert');

const tracker = require('../helpers/archipelagoTracker.js');

const TRACKER_PAGE = `
<table id="tracker-table">
  <thead>
    <tr>
      <th>#</th><th>Name</th><th>Game</th><th>Status</th><th>Checks</th><th>&percnt;</th><th>Last<wbr>Activity</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>1</td><td>Argus</td><td>Castlevania - Circle of the Moon</td><td>Goal Completed</td><td>124/124</td><td>100.00</td><td>1310107.5</td></tr>
    <tr><td>2</td><td>ChilledVoices</td><td>Voices of the Void</td><td>Disconnected</td><td>376/376</td><td>100.00</td><td>609864.5</td></tr>
    <tr><td>3</td><td>DaveRoR2</td><td>Risk of Rain 2</td><td>Disconnected</td><td>223/306</td><td>72.88</td><td>609446.1</td></tr>
    <tr><td>4</td><td>Dawn</td><td>Zillion</td><td>Playing</td><td>0/87</td><td>0.00</td><td>12.0</td></tr>
  </tbody>
</table>`;

test('extractTrackerId finds the tracker linked from a room page', () => {
    const room = `<p>Multiworld <a href="/tracker/LnE6uVNnRyKELE6KTEZCFA">tracker</a></p>`;
    assert.strictEqual(tracker.extractTrackerId(room), 'LnE6uVNnRyKELE6KTEZCFA');
    assert.strictEqual(tracker.extractTrackerId('<p>no tracker here</p>'), null);
    assert.strictEqual(tracker.extractTrackerId(null), null);
});

test('extractTrackerId is not fooled by the per-slot tracker links', () => {
    // The room page also links /tracker/<id>/0/1 for every slot; any of them yields the same id.
    const room = `<a href="/tracker/LnE6uVNnRyKELE6KTEZCFA/0/7">slot 7</a>`;
    assert.strictEqual(tracker.extractTrackerId(room), 'LnE6uVNnRyKELE6KTEZCFA');
});

test('parseTrackerRows reads slot, name, status and the checks column', () => {
    const rows = tracker.parseTrackerRows(TRACKER_PAGE);
    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(rows[0], {
        slot: 1, name: 'Argus', status: 'Goal Completed', checked: 124, total: 124
    });
    assert.deepStrictEqual(rows[2], {
        slot: 3, name: 'DaveRoR2', status: 'Disconnected', checked: 223, total: 306
    });
});

test('parseTrackerRows locates columns by header, not by position', () => {
    const reordered = TRACKER_PAGE
        .replace('<th>#</th><th>Name</th><th>Game</th><th>Status</th><th>Checks</th>',
                 '<th>Checks</th><th>#</th><th>Name</th><th>Game</th><th>Status</th>')
        .replace(/<td>(\d+)<\/td><td>(\w+)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>(\d+\/\d+)<\/td>/g,
                 '<td>$5</td><td>$1</td><td>$2</td><td>$3</td><td>$4</td>');
    const rows = tracker.parseTrackerRows(reordered);
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].slot, 1);
    assert.strictEqual(rows[0].checked, 124);
    assert.strictEqual(rows[0].total, 124);
});

test('parseTrackerRows returns nothing rather than throwing on unexpected markup', () => {
    assert.deepStrictEqual(tracker.parseTrackerRows('<html>nothing here</html>'), []);
    assert.deepStrictEqual(tracker.parseTrackerRows(''), []);
    assert.deepStrictEqual(tracker.parseTrackerRows(null), []);
    // A table whose header has no Checks column is not one we can use.
    assert.deepStrictEqual(tracker.parseTrackerRows('<thead><tr><th>#</th><th>Name</th></tr></thead><tr><td>1</td><td>x</td></tr>'), []);
});

test('fullyCheckedSlots picks the 100% slots regardless of their status', () => {
    const done = tracker.fullyCheckedSlots(tracker.parseTrackerRows(TRACKER_PAGE));
    // Argus goaled; ChilledVoices did not, and is exactly the case the socket cannot see.
    assert.ok(done.has('0:1'));
    assert.ok(done.has('0:2'));
    assert.ok(!done.has('0:3'), '223/306 is not finished');
    assert.ok(!done.has('0:4'), '0/87 is not finished');
    assert.strictEqual(done.size, 2);
});

test('fullyCheckedSlots ignores a slot with no locations at all', () => {
    // 0/0 would otherwise read as "complete" and silence a slot that never started.
    const done = tracker.fullyCheckedSlots([{ slot: 9, checked: 0, total: 0 }]);
    assert.strictEqual(done.size, 0);
});

test('fullyCheckedSlots keys by team', () => {
    const done = tracker.fullyCheckedSlots([{ slot: 5, checked: 10, total: 10 }], 2);
    assert.ok(done.has('2:5'));
});
