const test = require('node:test');
const assert = require('node:assert');
const { ApplicationCommandOptionType } = require('discord.js');

const { buildQueryString, buildSpec } = require('../helpers/slashRegistry.js');

// Minimal interaction stub — just the surface buildQueryString actually touches.
function makeInteraction({ subcommand, values }) {
    return {
        options: {
            getSubcommand(required = true) {
                if (subcommand) return subcommand;
                if (required) throw new Error('no subcommand');
                return null;
            },
            get(name) {
                if (!(name in values)) return null;
                return { name, value: values[name] };
            }
        }
    };
}

const playSpec = {
    subcommands: [
        { name: 'play', options: [
            { name: 'name',    type: 'STRING',  required: true },
            { name: 'shuffle', type: 'BOOLEAN', flag: '-r', required: false }
        ]}
    ]
};

test('emits the literal `flag` token when BOOLEAN value is true', () => {
    const interaction = makeInteraction({ subcommand: 'play', values: { name: 'mylist', shuffle: true } });
    assert.strictEqual(buildQueryString(interaction, playSpec), 'play mylist -r');
});

test('omits the flag token when BOOLEAN value is false', () => {
    const interaction = makeInteraction({ subcommand: 'play', values: { name: 'mylist', shuffle: false } });
    assert.strictEqual(buildQueryString(interaction, playSpec), 'play mylist');
});

test('omits the flag token when BOOLEAN option is absent', () => {
    const interaction = makeInteraction({ subcommand: 'play', values: { name: 'mylist' } });
    assert.strictEqual(buildQueryString(interaction, playSpec), 'play mylist');
});

test('BOOLEAN without a flag falls back to stringified value (backward compat)', () => {
    const spec = {
        subcommands: [
            { name: 'sub', options: [
                { name: 'flag1', type: 'BOOLEAN', required: false }
            ]}
        ]
    };
    const interaction = makeInteraction({ subcommand: 'sub', values: { flag1: true } });
    assert.strictEqual(buildQueryString(interaction, spec), 'sub true');
});

test('STRING options still emit their value as-is', () => {
    const spec = {
        subcommands: [
            { name: 'create', options: [
                { name: 'name', type: 'STRING', required: true }
            ]}
        ]
    };
    const interaction = makeInteraction({ subcommand: 'create', values: { name: 'partymix' } });
    assert.strictEqual(buildQueryString(interaction, spec), 'create partymix');
});

test('buildSpec expands subcommands with choices into the Discord option shape', () => {
    const slash = {
        description: 'game',
        subcommands: [
            { name: 'set', description: 'change a setting', options: [
                { name: 'setting', type: 'STRING', required: true, choices: [{ name: 'Goal', value: 'goal' }] },
                { name: 'value',   type: 'INTEGER', required: true }
            ]},
            { name: 'join', description: 'join', options: [] }
        ]
    };
    const spec = buildSpec('hitster', slash);

    assert.strictEqual(spec.name, 'hitster');
    assert.strictEqual(spec.options.length, 2);

    const setSub = spec.options.find(o => o.name === 'set');
    assert.strictEqual(setSub.type, ApplicationCommandOptionType.Subcommand);
    assert.strictEqual(setSub.options.length, 2);

    const settingOpt = setSub.options.find(o => o.name === 'setting');
    assert.strictEqual(settingOpt.type, ApplicationCommandOptionType.String);
    assert.deepStrictEqual(settingOpt.choices, [{ name: 'Goal', value: 'goal' }]);

    const valueOpt = setSub.options.find(o => o.name === 'value');
    assert.strictEqual(valueOpt.type, ApplicationCommandOptionType.Integer);

    const joinSub = spec.options.find(o => o.name === 'join');
    assert.strictEqual(joinSub.type, ApplicationCommandOptionType.Subcommand);
    assert.deepStrictEqual(joinSub.options, []);
});

test('omitFromQuery keeps an option out of the arg string (command reads it off the interaction)', () => {
    const slash = {
        options: [
            { name: 'vibe', type: 'STRING' },
            { name: 'ttrpg', type: 'BOOLEAN', omitFromQuery: true }
        ]
    };
    const interaction = makeInteraction({ values: { vibe: 'spooky forest', ttrpg: true } });

    assert.strictEqual(buildQueryString(interaction, slash), 'spooky forest');
});

test('omitFromQuery is not sent to Discord as part of the option spec', () => {
    const spec = buildSpec('vibe', {
        description: 'x',
        options: [{ name: 'ttrpg', type: 'BOOLEAN', omitFromQuery: true, description: 'y' }]
    });

    assert.strictEqual(spec.options[0].type, ApplicationCommandOptionType.Boolean);
    assert.ok(!('omitFromQuery' in spec.options[0]));
});
