// Keeping a room password out of the command log.
//
// `app/music.js` writes every invocation's arguments to data/logs/commands-*.jsonl before the
// command runs, `commandLog.secrets()` only knows the static secrets in config/, and day-files are
// kept forever. So a secret typed at runtime is a permanent plaintext record unless something
// strips it first. `!ap password` already deletes the Discord message carrying it; this is the
// same care applied to the copy that goes to disk.
//
// Two mechanisms, because the two dispatch paths differ:
//   prefix — the command's own `redactArgs`, which knows its argument grammar.
//   slash  — options marked `sensitive` in the spec, stripped by VALUE. buildQueryString flattens
//            options into a bare string, and `/ap watch` has two optional options in a row, so the
//            secret sits at no fixed index. Both of those were live holes in the first fix.

const test = require('node:test');
const assert = require('node:assert');

const ap = require('../commands/archipelago.js');
const slashRegistry = require('../helpers/slashRegistry.js');

const SECRET = 'correct-horse-battery-staple';

/** app/music.js's loggableArgs, in the same order it composes them. */
function loggableArgs(cmd, args, secrets = []) {
    let text = String(args == null ? '' : args);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return cmd && typeof cmd.redactArgs === 'function' ? cmd.redactArgs(text) : text;
}

function fakeInteraction(subcommand, values) {
    return {
        options: {
            getSubcommand: () => subcommand,
            get: (name) => (values[name] === undefined ? null : { value: values[name] }),
            data: []
        }
    };
}

test('the prefix redactor is case-insensitive, as the dispatcher is', () => {
    // `action` is lowercased in process(), so `!ap PASSWORD ...` really does set a password.
    // Matching case-sensitively let exactly that spelling through in clear text.
    for (const spelling of ['password', 'PASSWORD', 'PassWord']) {
        const out = ap.command.redactArgs(`${spelling} 3 ${SECRET}`);
        assert.ok(!out.includes(SECRET), `${spelling} leaked: ${out}`);
        assert.match(out, /\[redacted\]/);
    }
});

test('the prefix redactor keeps what makes the log worth having', () => {
    assert.strictEqual(ap.command.redactArgs('password 3 hunter2'), 'password 3 [redacted]',
        'the subcommand and the watch id are not secret');
    assert.strictEqual(ap.command.redactArgs('password 3 clear'), 'password 3 clear',
        'clearing is an action, not a secret');
    assert.strictEqual(ap.command.redactArgs('claim 3 ZackWord'), 'claim 3 ZackWord',
        'no other subcommand is touched');
});

test('a secret full of regex metacharacters is still removed', () => {
    // Redaction is a split/join on the literal value, so nothing here is interpreted.
    const nasty = 'a$1.*b[]\\^';
    assert.ok(!ap.command.redactArgs(`password 3 ${nasty}`).includes(nasty));
});

test('both password options in the slash spec are marked sensitive', () => {
    // /ap watch takes one too. The first fix only covered the `password` subcommand, so a password
    // handed to `/ap watch` went to disk in full.
    for (const [sub, values] of [
        ['watch', { room: 'https://archipelago.gg/room/x', slot: 'ZackWord', password: SECRET }],
        ['password', { password: SECRET, id: 3 }]
    ]) {
        const found = slashRegistry.sensitiveValues(fakeInteraction(sub, values), ap.command.slash);
        assert.ok(found.includes(SECRET), `/ap ${sub} did not report its password as sensitive`);
    }
});

test('no secret survives the chain music.js actually runs', () => {
    const cases = [
        ['watch', { room: 'https://archipelago.gg/room/x', slot: 'ZackWord', password: SECRET }],
        // label present shifts the password one token along, which is why redaction is by value
        // and not by position.
        ['watch', { room: 'https://archipelago.gg/room/x', slot: 'ZackWord', label: 'Big async', password: SECRET }],
        ['password', { password: SECRET, id: 3 }]
    ];
    for (const [sub, values] of cases) {
        const interaction = fakeInteraction(sub, values);
        const query = slashRegistry.buildQueryString(interaction, ap.command.slash);
        assert.ok(query.includes(SECRET), 'precondition: the raw query does carry the secret');

        const logged = loggableArgs(ap.command, query, slashRegistry.sensitiveValues(interaction, ap.command.slash));
        assert.ok(!logged.includes(SECRET), `/ap ${sub} leaked into the log: ${logged}`);
    }
});

test('a subcommand carrying no secret is left alone', () => {
    const interaction = fakeInteraction('claim', { slot: 'ZackWord', id: 3 });
    assert.deepStrictEqual(slashRegistry.sensitiveValues(interaction, ap.command.slash), []);
});

test('sensitiveValues never throws, whatever it is handed', () => {
    // It runs before the dispatcher's try/catch, so an exception would take the command down —
    // and only ever on the invocations that carry a secret.
    assert.doesNotThrow(() => {
        slashRegistry.sensitiveValues(null, null);
        slashRegistry.sensitiveValues({}, ap.command.slash);
        slashRegistry.sensitiveValues({ options: {} }, ap.command.slash);
        slashRegistry.sensitiveValues(fakeInteraction('nosuchsub', {}), ap.command.slash);
    });
});

test('the sensitive marker never reaches the Discord payload', () => {
    // mapOption whitelists fields; if that ever changes, Discord rejects the whole registration.
    const spec = slashRegistry.buildSpec('ap', ap.command.slash);
    assert.ok(!JSON.stringify(spec).includes('sensitive'));
});
