const test = require('node:test');
const assert = require('node:assert');

const { buildQueryString } = require('../helpers/slashRegistry.js');

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
