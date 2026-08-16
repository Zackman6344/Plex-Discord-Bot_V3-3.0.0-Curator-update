const test = require('node:test');
const assert = require('node:assert');

const {
    buildKometaEmbed, buildKometaChangesEmbed, isNoteworthyChange,
    buildGameLaunchEmbed, buildStartupEmbed, buildGamePresenceEmbed,
    pickChannelId, startupChannelId,
} = require('../helpers/broadcast.js');
const { startedGames } = require('../helpers/gamePresence.js');
const config = require('../config/config.js');

// EmbedBuilder stores its raw payload on `.data`; assert against that.

test('Kometa run_end embed shows only the stats that were sent', () => {
    const embed = buildKometaEmbed({
        event: 'run_end',
        run_time: '00:14',
        collections_modified: 3,
        items_added: 42,
    });
    const d = embed.data;
    assert.strictEqual(d.title, '📚 Kometa run finished');
    assert.ok(!d.description, 'should not fall back to the no-changes description when stats exist');

    const names = d.fields.map((f) => f.name);
    assert.ok(names.includes('⏱ Run time'));
    assert.ok(names.includes('📦 Collections'));
    assert.ok(names.includes('🎬 Items'));
    assert.ok(!names.includes('⬇️ Requested'), 'omitted stats produce no field');

    const collections = d.fields.find((f) => f.name === '📦 Collections');
    assert.strictEqual(collections.value, 'Modified: 3');
});

test('Kometa run_end with no stats falls back to a no-changes description', () => {
    const embed = buildKometaEmbed({ event: 'run_end' });
    assert.strictEqual(embed.data.description, 'Finished with no changes.');
    assert.ok(!embed.data.fields || embed.data.fields.length === 0);
});

test('Kometa error event is a red embed carrying the error text', () => {
    const embed = buildKometaEmbed({ event: 'error', error: 'Plex unreachable' });
    assert.strictEqual(embed.data.title, '⚠️ Kometa error');
    assert.strictEqual(embed.data.color, 0xED4245);
    assert.ok(embed.data.description.includes('Plex unreachable'));
});

test('missing event defaults to run_end', () => {
    const embed = buildKometaEmbed({ run_time: '00:05' });
    assert.strictEqual(embed.data.title, '📚 Kometa run finished');
});

test('game-launch embed includes store and platform', () => {
    const embed = buildGameLaunchEmbed({ name: 'Hades', source: 'Steam', platform: 'PC (Windows)' });
    const d = embed.data;
    assert.strictEqual(d.title, '🎮 Hades launched');
    const store = d.fields.find((f) => f.name === '🛒 Store');
    const platform = d.fields.find((f) => f.name === '🖥 Platform');
    assert.strictEqual(store.value, 'Steam');
    assert.strictEqual(platform.value, 'PC (Windows)');
    assert.ok(!d.thumbnail, 'no cover attachment name means no thumbnail');
});

test('game-launch embed omits platform field when absent and defaults source to Local', () => {
    const embed = buildGameLaunchEmbed({ name: 'Some Game' });
    const d = embed.data;
    const names = d.fields.map((f) => f.name);
    assert.ok(names.includes('🛒 Store'));
    assert.ok(!names.includes('🖥 Platform'));
    assert.strictEqual(d.fields.find((f) => f.name === '🛒 Store').value, 'Local');
});

test('game-launch embed wires the thumbnail to the cover attachment when provided', () => {
    const embed = buildGameLaunchEmbed({ name: 'Hades', source: 'Steam' }, 'cover.jpg');
    assert.strictEqual(embed.data.thumbnail.url, 'attachment://cover.jpg');
});

test('changes embed: a created collection is a gold "New collection" with a poster', () => {
    const embed = buildKometaChangesEmbed({
        event: 'changes', created: true, collection: 'New Stuff', library_name: 'Movies',
        additions: [{ title: 'A' }], poster_url: 'https://x/p.jpg',
    });
    const d = embed.data;
    assert.strictEqual(d.title, '✨ New collection: New Stuff');
    assert.strictEqual(d.color, 0xFEE75C);
    assert.strictEqual(d.thumbnail.url, 'https://x/p.jpg');
    assert.ok(d.fields.some((f) => f.name.startsWith('➕ Added')));
});

test('changes embed: growth shows count, a truncated add list, and server requests', () => {
    const additions = Array.from({ length: 15 }, (_, i) => ({ title: `Movie ${i + 1}` }));
    const embed = buildKometaChangesEmbed({
        event: 'changes', collection: 'Top Rated', library_name: 'Movies',
        additions, radarr_adds: [{ title: 'Requested One' }], sonarr_adds: [{ title: 'Requested Two' }],
    });
    const d = embed.data;
    assert.strictEqual(d.title, '📈 Top Rated grew by 15');
    const added = d.fields.find((f) => f.name.startsWith('➕ Added'));
    assert.strictEqual(added.name, '➕ Added (15)');
    assert.ok(added.value.includes('+3 more')); // 12 shown of 15
    const recs = d.fields.find((f) => f.name === '📥 Requested for the server');
    assert.strictEqual(recs.value, 'Requested One, Requested Two');
});

test('buildKometaEmbed delegates a changes event to the changes embed', () => {
    const embed = buildKometaEmbed({ event: 'changes', collection: 'X', additions: [{ title: 'a' }] });
    assert.strictEqual(embed.data.title, '📈 X grew by 1');
});

test('isNoteworthyChange: created / requests / threshold qualify; removals-only does not', () => {
    const saved = config.kometaChangesMinAdds;
    try {
        config.kometaChangesMinAdds = 1;
        assert.strictEqual(isNoteworthyChange({ created: true }), true);
        assert.strictEqual(isNoteworthyChange({ additions: [{ title: 'a' }] }), true);
        assert.strictEqual(isNoteworthyChange({ radarr_adds: [{ title: 'a' }] }), true);
        assert.strictEqual(isNoteworthyChange({ removals: [{ title: 'a' }], additions: [] }), false);
        assert.strictEqual(isNoteworthyChange({}), false);

        config.kometaChangesMinAdds = 5;
        assert.strictEqual(isNoteworthyChange({ additions: Array(3).fill({ title: 'a' }) }), false);
        assert.strictEqual(isNoteworthyChange({ additions: Array(5).fill({ title: 'a' }) }), true);
    } finally {
        config.kometaChangesMinAdds = saved;
    }
});

test('startupChannelId: one channel — general fallback if set, else the first type channel', () => {
    const saved = { b: config.broadcastChannelId, k: config.kometaChannelId, g: config.gameLaunchChannelId };
    try {
        config.broadcastChannelId = 'GEN';
        config.kometaChannelId = 'KOM';
        config.gameLaunchChannelId = 'GAME';
        assert.strictEqual(startupChannelId(), 'GEN'); // general wins → single message, no fan-out

        config.broadcastChannelId = '';
        assert.strictEqual(startupChannelId(), 'KOM'); // else first type channel

        config.kometaChannelId = '';
        assert.strictEqual(startupChannelId(), 'GAME');

        config.gameLaunchChannelId = '';
        assert.strictEqual(startupChannelId(), '');
    } finally {
        config.broadcastChannelId = saved.b;
        config.kometaChannelId = saved.k;
        config.gameLaunchChannelId = saved.g;
    }
});

test('startup embed announces the system is up and lists enabled broadcasts', () => {
    const embed = buildStartupEmbed();
    assert.strictEqual(embed.data.title, '✅ System has started');
    assert.ok(embed.data.fields.some((f) => f.name === 'Broadcasts enabled'));
});

test('game-presence embed names the game and who started it', () => {
    const embed = buildGamePresenceEmbed({ user: 'Zack', game: 'Hades' });
    assert.strictEqual(embed.data.title, '🎮 Hades');
    assert.ok(embed.data.description.includes('Zack'));
});

test('startedGames: reports only newly-started Playing games, ignoring other activity types', () => {
    // Playing == ActivityType.Playing == 0; a custom status (4) must be ignored.
    const first = startedGames(new Set(), [{ type: 0, name: 'Hades' }, { type: 4, name: 'chilling' }]);
    assert.deepStrictEqual(first.started, ['Hades']);
    assert.ok(first.now.has('Hades') && !first.now.has('chilling'));

    // Same game still running → not re-announced.
    const second = startedGames(first.now, [{ type: 0, name: 'Hades' }]);
    assert.deepStrictEqual(second.started, []);

    // Switching games announces the new one.
    const third = startedGames(second.now, [{ type: 0, name: 'Celeste' }]);
    assert.deepStrictEqual(third.started, ['Celeste']);
});

test('pickChannelId: dedicated channel wins, otherwise falls back to broadcastChannelId', () => {
    const saved = {
        b: config.broadcastChannelId,
        k: config.kometaChannelId,
        g: config.gameLaunchChannelId,
    };
    try {
        config.broadcastChannelId = 'FALLBACK';
        config.kometaChannelId = '';
        config.gameLaunchChannelId = 'GAME';
        assert.strictEqual(pickChannelId('kometa'), 'FALLBACK'); // no dedicated → fallback
        assert.strictEqual(pickChannelId('game'), 'GAME');       // dedicated wins

        config.kometaChannelId = 'KOMETA';
        assert.strictEqual(pickChannelId('kometa'), 'KOMETA');

        config.broadcastChannelId = '';
        config.gameLaunchChannelId = '';
        assert.strictEqual(pickChannelId('game'), '');           // nothing set → empty
    } finally {
        config.broadcastChannelId = saved.b;
        config.kometaChannelId = saved.k;
        config.gameLaunchChannelId = saved.g;
    }
});
