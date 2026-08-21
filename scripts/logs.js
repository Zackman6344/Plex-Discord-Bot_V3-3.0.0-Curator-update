#!/usr/bin/env node
// scripts/logs.js
//
// Reads back what the bot was asked to do and what it said. Pairs each invocation with its
// outcome and the messages that followed it, so a session reads as a transcript rather than as
// two unrelated streams.
//
//   npm run logs                     last 15 invocations
//   npm run logs -- --n=50           more of them
//   npm run logs -- --errors         only the ones that failed
//   npm run logs -- --command=vibe   one command
//   npm run logs -- --since=30m      last half hour (s/m/h/d)
//   npm run logs -- --user=<id>      one person
//   npm run logs -- --stats          totals and the busiest commands
//   npm run logs -- --raw            the underlying JSONL, unfolded

const commandLog = require('../helpers/commandLog.js');

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name, fallback = null) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const DURATION = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseSince(text) {
    if (!text) return null;
    const match = /^(\d+)([smhd])$/.exec(text.trim());
    return match ? Number(match[1]) * DURATION[match[2]] : null;
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const clock = (iso) => {
    try { return new Date(iso).toLocaleTimeString(); } catch (_) { return iso; }
};

if (flag('stats')) {
    const s = commandLog.stats();
    console.log(bold('Command log') + dim(` — ${s.dir}`));
    console.log(`  ${s.invocations} invocations, ${s.outputs} outputs, ${s.failures} failures, ${s.events} events total`);
    if (s.topCommands.length) {
        console.log(bold('\n  Busiest commands'));
        for (const [name, count] of s.topCommands) console.log(`    ${String(count).padStart(4)}  ${name}`);
    }
    process.exit(0);
}

if (flag('raw')) {
    for (const event of commandLog.readEvents().slice(-Number(value('n', 100)))) {
        console.log(JSON.stringify(event));
    }
    process.exit(0);
}

const { invocations, unattached } = commandLog.readInvocations({
    limit: Number(value('n', 15)),
    command: value('command'),
    userId: value('user'),
    errorsOnly: flag('errors'),
    sinceMs: parseSince(value('since'))
});

if (invocations.length === 0) {
    console.log('No invocations logged yet.');
    console.log(dim(`(looking in ${commandLog._dir} — the bot writes there as commands run)`));
    process.exit(0);
}

// Oldest first reads more naturally as a transcript.
for (const inv of invocations.slice().reverse()) {
    const status = inv.ok === false ? red('FAILED')
        : inv.ok === null ? yellow('no outcome recorded')
        : green('ok');
    const took = inv.ms === null ? '' : dim(` ${inv.ms}ms`);

    console.log(
        `${dim(clock(inv.t))}  ${bold(inv.path + ' ' + (inv.command || '?'))}` +
        (inv.args ? ` ${JSON.stringify(inv.args)}` : '') +
        `  ${dim('by ' + (inv.user || '?') + (inv.channel ? ' in #' + inv.channel : ''))}`
    );
    console.log(`   ${status}${took}`);

    if (inv.error) {
        for (const line of String(inv.error).split('\n').slice(0, 4)) console.log(red('   ! ' + line));
    }

    for (const out of inv.outputs.slice(0, 6)) {
        const marker = out.kind === 'interaction-reply' ? '<-' : '<<';
        if (out.content) console.log(dim(`   ${marker} `) + out.content);
        for (const embed of out.embeds || []) {
            const bits = [embed.title, embed.description].filter(Boolean).join(' — ');
            console.log(dim(`   ${marker} [embed] `) + (bits || dim(`(${embed.fields} fields)`)));
        }
        if (out.components) console.log(dim(`   ${marker} [${out.components} button row(s)]`));
    }
    if (inv.outputs.length > 6) console.log(dim(`   … ${inv.outputs.length - 6} more messages`));
    console.log('');
}

if (unattached.length && !flag('command') && !flag('errors')) {
    console.log(dim(`(${unattached.length} message(s) not tied to a command — background broadcasts, game timers, and the like)`));
}
