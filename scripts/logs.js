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
//   npm run logs -- --events         background events (tracks, voice joins, crashes)
//   npm run logs -- --events --kind=voice-join-failed   one kind
//   npm run logs -- --stats          totals and the busiest commands
//   npm run logs -- --raw            the underlying JSONL, unfolded
//   npm run logs -- --days=60        widen the read window (default 14)
//   npm run logs -- --all            every day-file there is
//
// Day-files are kept indefinitely, so anything older than the default window needs --days or
// --all. A --since longer than the window widens it on its own.

const commandLog = require('../helpers/commandLog.js');

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name, fallback = null) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

// null lets each reader pick its own default; 0 means every day-file there is. A bad --days is
// refused rather than silently widening the read to the whole archive, which is what Number()
// giving NaN used to do.
const rawDays = value('days');
// A plain decimal integer, so "0x10" and "1e3" are rejected rather than quietly meaning 16 and
// 1000 to somebody who mistyped a window.
if (rawDays !== null && (!/^\d+$/.test(rawDays.trim()) || commandLog.countOr(rawDays, -1) < 0)) {
    console.error(`--days must be a whole number of day-files (0, or --all, reads every one); got "${rawDays}"`);
    process.exit(2);
}
const readDays = flag('all') ? 0 : (rawDays !== null ? commandLog.countOr(rawDays, null) : null);

// Same for --n. slice(-0) returns the whole array rather than nothing, so an unchecked 0 printed
// the entire read window.
const limitOf = (fallback) => {
    const raw = value('n');
    if (raw === null) return fallback;
    const parsed = commandLog.countOr(raw, -1);
    if (parsed < 1) {
        console.error(`--n must be a positive whole number; got "${raw}"`);
        process.exit(2);
    }
    return parsed;
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
    const s = commandLog.stats(readDays === null ? {} : { days: readDays });
    console.log(bold('Command log') + dim(` — ${s.dir}`));
    const scope = s.windowed
        ? `the last ${s.windowDays} of ${s.filesOnDisk} day-files`
        : `all ${s.filesOnDisk} day-file(s)`;
    console.log(`  ${s.invocations} invocations, ${s.outputs} outputs, ${s.failures} failures, ${s.events} events`);
    console.log(dim(`  over ${scope}${s.windowed ? ' — pass --all for the lifetime totals' : ''}`));
    if (s.topCommands.length) {
        console.log(bold('\n  Busiest commands'));
        for (const [name, count] of s.topCommands) console.log(`    ${String(count).padStart(4)}  ${name}`);
    }
    process.exit(0);
}

if (flag('events')) {
    const events = commandLog.readEventLog({
        limit: limitOf(40),
        kind: value('kind'),
        ...(readDays === null ? {} : { days: readDays })
    });
    // Same disclosure as the invocation listing: this read is windowed and the store is not.
    const eventWindow = commandLog.windowInfo({ days: readDays });
    const eventNote = eventWindow.windowed
        ? `read the newest ${eventWindow.windowDays} of ${eventWindow.filesOnDisk} day-files — pass --all, or --days=N, to widen`
        : null;
    if (events.length === 0) {
        console.log(eventNote ? 'No background events in the window read.' : 'No background events logged yet.');
        if (eventNote) console.log(dim(`(${eventNote})`));
        process.exit(0);
    }
    for (const e of events) {
        const { t, type, kind, ...rest } = e;
        const detail = Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        const label = /fail|error|exception|rejection/.test(kind) ? red(kind) : bold(kind);
        console.log(`${dim(clock(t))}  ${label}  ${dim(detail)}`);
    }
    if (eventNote) console.log(dim(`(${eventNote})`));
    process.exit(0);
}

if (flag('raw')) {
    const rawEvents = commandLog.readEvents(readDays === null ? {} : { days: readDays });
    for (const event of rawEvents.slice(-limitOf(100))) {
        console.log(JSON.stringify(event));
    }
    process.exit(0);
}

const { invocations, unattached } = commandLog.readInvocations({
    limit: limitOf(15),
    command: value('command'),
    userId: value('user'),
    errorsOnly: flag('errors'),
    sinceMs: parseSince(value('since')),
    days: readDays
});

// Day-files are kept forever but reads still default to a window, so every answer here has to say
// when there is more behind it. Without this, a search whose match fell outside the window
// reported "No invocations logged yet." with a year of files sitting on disk.
const readWindow = commandLog.windowInfo({ days: readDays, sinceMs: parseSince(value('since')) });
const windowNote = readWindow.windowed
    ? `read the newest ${readWindow.windowDays} of ${readWindow.filesOnDisk} day-files — pass --all, or --days=N, to widen`
    : null;

if (invocations.length === 0) {
    console.log(windowNote ? 'No matching invocations in the window read.' : 'No invocations logged yet.');
    if (windowNote) console.log(dim(`(${windowNote})`));
    console.log(dim(`(looking in ${commandLog._dir} — the bot writes there as commands run)`));
    process.exit(0);
}

// Oldest first reads more naturally as a transcript.
for (const inv of invocations.slice().reverse()) {
    const status = inv.ok === false ? red('FAILED')
        : inv.ok === null ? yellow('no outcome recorded')
        : inv.awaited === false ? yellow('dispatched') + dim(' (returned immediately; async work may still be running)')
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

if (windowNote) console.log(dim(`(${windowNote})`));
