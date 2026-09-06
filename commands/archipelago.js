// commands/archipelago.js
//
// Front end for the Archipelago room monitor. The bot joins a multiworld as a read-only
// tracker client and relays the server log into the channel the watch was created in.

const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const config = require('../config/config.js');
const logger = require('../helpers/logger.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const claims = require('../helpers/archipelagoClaims.js');
const goals = require('../helpers/archipelagoGoals.js');
const leaderboard = require('../helpers/leaderboard.js');

const WATCH_ID_HELP = 'Watch ID — leave empty if there is only one room';

// Owned by archipelagoClaims, so the modes, their descriptions and the slash choices below are
// all one list.
const PING_HELP = claims.PING_HELP;

// Slot names come from players' own YAML, so they reach a reply as text nobody here wrote.
//
// Wrapping them in an inline code span is the containment: Discord applies no markdown inside
// one, so nothing needs escaping. Running escapeMarkdown first was actively wrong, because the
// backslashes it inserts are not escapes inside a span, they are literal characters — a slot
// named `Zack_Word` rendered as `Zack\_Word`, and underscores are everywhere in slot names. The
// only character that matters is the backtick, which would close the span early.
const slotLabel = (name) => `\`${String(name || '').replace(/`/g, "'")}\``;

const CATEGORY_HELP = {
    items: 'item sends (and cheated items)',
    hints: 'hints',
    chat: 'player and server chat',
    joins: 'joins, parts and tag changes',
    goals: 'goals, releases and collects',
    deaths: 'DeathLink deaths (reconnects to add the tag)',
    misc: 'countdowns, tutorials, command output'
};

function truthy(word) {
    return ['on', 'true', 'yes', 'y', '1', 'enable', 'enabled'].includes(String(word || '').toLowerCase());
}

function falsy(word) {
    return ['off', 'false', 'no', 'n', '0', 'disable', 'disabled'].includes(String(word || '').toLowerCase());
}

function statusIcon(status) {
    if (status === 'connected') return '🟢';
    if (status === 'paused' || status === 'stopped') return '🔴';
    if (status === 'connecting') return '🟡';
    return '🟠';
}

function isOwner(msg) {
    if (!config.ownerId) return true;
    return msg.author && msg.author.id === config.ownerId;
}

function buildListEmbed(entries) {
    const embed = new EmbedBuilder()
        .setColor('#2F3136')
        .setTitle('🧩 Archipelago room watches');

    if (entries.length === 0) {
        const gaps = monitor.configGaps();
        return embed.setDescription(
            `No rooms are being watched.\n\n` +
            (config.archipelagoEnabled && gaps.length > 0
                ? `\`/config\` → **Archipelago** still needs ${gaps.join(', ')}.\n`
                : '') +
            `Or add a room here with \`${config.commandPrefix}ap watch <room url> <slot name>\`.`
        );
    }

    for (const entry of entries) {
        const { watch } = entry;
        const filters = Object.entries(watch.filters || {})
            .filter(([, on]) => on)
            .map(([group]) => group)
            .join(', ') || 'none';

        embed.addFields({
            name: `${statusIcon(entry.status)} #${watch.id} — ${watch.label}${watch.managed ? ' (from /config)' : ''}`,
            value: [
                `**Slot:** ${slotLabel(watch.slot)}${watch.password ? ' (password set)' : ''}`,
                `**Room:** ${monitor.describeTarget(watch.target)}`,
                `**Address:** ${entry.address || '—'}`,
                `**Channel:** <#${watch.channelId}>`,
                `**State:** ${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`,
                `**Relayed:** ${entry.lineCount} line(s)${entry.droppedLines ? `, ${entry.droppedLines} dropped` : ''}`,
                `**Showing:** ${filters}${watch.progressionOnly ? ' · progression items only' : ''}`,
                `**Extras:** ${watch.color !== false ? 'colour' : 'no colour'} · ${watch.markers !== false ? 'markers' : 'no markers'} · ` +
                    (watch.skipGoaled !== false
                        ? `hiding items to ${entry.finished || 0} finished slot(s)`
                        : 'showing items to finished slots')
            ].join('\n')
        });
    }

    return embed;
}

module.exports = {
    name: 'ap',
    aliases: ['archipelago'],
    command: {
        usage: '!ap [watch/list/status/unwatch/filter/progression/password/retry]',
        description: 'Watch an Archipelago multiworld and relay its log into this channel.',
        // The command log records every invocation's arguments before dispatch, and commandLog's
        // own redaction only knows the static secrets in config/. A room password is typed at
        // runtime, so without this it landed in data/logs/commands-*.jsonl in clear text — and
        // day-files are now kept forever, which turned a 14-day exposure into a permanent one.
        // `!ap password` deletes the Discord message carrying the secret; this is the same care
        // applied to the copy that goes to disk.
        //
        // Token order differs between the two forms: prefix gives `password <id> <secret>`, the
        // slash builder gives `password <secret> <id>`. Keeping the subcommand and any bare
        // integer covers both without depending on which is which, and `clear` is not a secret.
        redactArgs(args) {
            const words = String(args || '').trim().split(/\s+/);
            // Lowercased to match how the dispatcher reads it (`action` at the top of process()).
            // Comparing case-sensitively meant `!ap PASSWORD 3 hunter2` ran as the password
            // command and was logged in full, which is the whole thing this exists to prevent.
            if ((words[0] || '').toLowerCase() !== 'password') return args;
            return words
                .map((word, i) => {
                    if (i === 0 || /^\d+$/.test(word) || word.toLowerCase() === 'clear') return word;
                    return '[redacted]';
                })
                .join(' ');
        },
        slash: {
            description: 'Watch an Archipelago room and relay its log here',
            subcommands: [
                { name: 'watch', description: 'Start relaying a multiworld log into this channel', options: [
                    { name: 'room', type: 'STRING', required: true, description: 'Room URL, or host:port of the server' },
                    { name: 'slot', type: 'STRING', required: true, description: 'An existing slot name to observe from' },
                    { name: 'label', type: 'STRING', required: false, description: 'Name to show in status output' },
                    { name: 'password', type: 'STRING', required: false, sensitive: true, description: 'Room password — visible in channel; prefer !ap password' }
                ] },
                // `id` is optional throughout and trails the required options, because Discord
                // rejects a payload where a required option follows an optional one. Leaving it
                // out picks the only watch there is, which is the normal case.
                { name: 'list', description: 'Show every room being watched', options: [] },
                { name: 'status', description: 'Show detail for one watch', options: [
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'unwatch', description: 'Stop watching a room', options: [
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'filter', description: 'Turn one category of log line on or off', options: [
                    { name: 'category', type: 'STRING', required: true, description: 'Which lines to toggle', choices: [
                        { name: 'items', value: 'items' },
                        { name: 'hints', value: 'hints' },
                        { name: 'chat', value: 'chat' },
                        { name: 'joins', value: 'joins' },
                        { name: 'goals', value: 'goals' },
                        { name: 'deaths', value: 'deaths' },
                        { name: 'misc', value: 'misc' }
                    ] },
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Show these lines?' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'progression', description: 'Relay only progression item sends', options: [
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Progression items only?' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'skipgoaled', description: 'Hide items sent to slots that already finished', options: [
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Hide them?' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'infer', description: 'Also treat a 100%-checked slot as finished', options: [
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Read the room tracker for completion?' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'color', description: 'Colour item names by class (desktop and web only)', options: [
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Use colour?' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'markers', description: 'Mark item names by class (works on mobile)', options: [
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Use markers?' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'claim', description: 'Get pinged when a slot receives something', options: [
                    { name: 'slot', type: 'STRING', required: true, description: 'The slot name you play' },
                    { name: 'user', type: 'USER', required: false, description: 'Claim on someone else\'s behalf (owner only)' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'unclaim', description: 'Stop being pinged for a slot', options: [
                    { name: 'slot', type: 'STRING', required: true, description: 'The slot name to release' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'claims', description: 'Show who has claimed which slots', options: [
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'pings', description: 'Choose how much a claimed slot pings you', options: [
                    { name: 'slot', type: 'STRING', required: true, description: 'A slot you have claimed' },
                    { name: 'mode', type: 'STRING', required: true, description: 'How much to ping',
                        choices: claims.PING_MODES.map(mode => ({ name: mode, value: mode })) },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'goals', description: 'How many multiworlds someone has goaled', options: [
                    { name: 'user', type: 'USER', required: false, description: 'Whose tally (defaults to yours)' }
                ] },
                { name: 'leaderboard', description: 'Who has goaled the most', options: [] },
                { name: 'password', description: 'Set or clear a room password', options: [
                    { name: 'password', type: 'STRING', required: false, sensitive: true, description: 'Leave empty to clear' },
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] },
                { name: 'retry', description: 'Reconnect a paused watch', options: [
                    { name: 'id', type: 'INTEGER', required: false, description: WATCH_ID_HELP }
                ] }
            ]
        },
        process: async function(...args) {
            let msg = null;
            const commandArgs = [];
            for (const arg of args) {
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) msg = arg;
                else if (typeof arg === 'string') commandArgs.push(arg);
            }
            if (!msg) return logger.error('Critical Error: Could not locate the Discord message object!');

            const prefix = config.commandPrefix;
            const raw = commandArgs.join(' ').trim();
            const words = raw.split(/\s+/).filter(Boolean);
            const action = (words[0] || '').toLowerCase();
            const rest = raw.slice(words[0] ? words[0].length : 0).trim();

            // Slash invocations carry typed options; reading them directly avoids trying to
            // re-split a slot name that legitimately contains spaces out of a flat string.
            const interaction = msg.interaction || null;
            const opt = (name) => {
                if (!interaction || !interaction.options) return null;
                const found = interaction.options.get(name);
                return found && found.value !== undefined && found.value !== null ? found.value : null;
            };

            // Nothing this command says should ping anybody, so every reply goes through here
            // rather than each site remembering. Replies quote slot names, player names and
            // server error text, all written by somebody else: `!ap unclaim <@&role>` had the bot
            // echo that role mention live, and the participant role it creates is mentionable, so
            // any user could make the bot ping every Archipelago player at will.
            //
            // It also never rejects. Handlers `return say(...)` without awaiting, so a rejected
            // send would escape the try/catch below rather than being reported: a reply over
            // Discord's 2000-character limit produced no message and no error at all.
            const say = async (payload) => {
                try {
                    return await msg.channel.send(
                        typeof payload === 'string'
                            ? { content: payload, allowedMentions: { parse: [] } }
                            : { ...payload, allowedMentions: { parse: [] } }
                    );
                } catch (err) {
                    logger.warn(`!ap could not reply in ${msg.channel.id}:`, err.message || err);
                    return null;
                }
            };
            // Same rule for the connect flow, which edits its own status message with the room
            // address and whatever error text the server sent back.
            //
            // `message` is whatever say() returned, which is null when the first send failed, so
            // this falls back to saying it fresh rather than dereferencing that. It swallows on
            // the same terms as say() too: handlers `return editQuietly(...)` without awaiting, so
            // a rejection here would escape the try/catch below exactly as one from send did.
            const editQuietly = async (message, content) => {
                if (!message) return say(content);
                try {
                    return await message.edit({ content, allowedMentions: { parse: [] } });
                } catch (err) {
                    logger.warn(`!ap could not edit its status message in ${msg.channel.id}:`, err.message || err);
                    return say(content);
                }
            };

            if (!config.archipelagoEnabled) {
                return say(
                    '🧩 The Archipelago monitor is switched off.\n' +
                    'Set `archipelagoEnabled: true` in `config/config.js` and restart the bot to use it.'
                );
            }

            if (!action || action === 'help' || action === 'menu' || action === '?') {
                return say([
                    '🧩 **Archipelago room monitor**',
                    '*Relays a multiworld\'s server log into the channel you set it up in.*',
                    '',
                    `\`[id]\` is optional while only one room is being watched. \`${prefix}ap list\` shows the IDs when there are more.`,
                    '',
                    `\`${prefix}ap watch <room url|host:port> <slot name>\` — start watching. The slot name is any real slot in the multiworld; the bot attaches as a read-only tracker and never receives items.`,
                    `\`${prefix}ap list\` — every watch and its state.`,
                    `\`${prefix}ap status <id>\` — detail for one watch.`,
                    `\`${prefix}ap unwatch <id>\` — stop and forget a watch.`,
                    `\`${prefix}ap filter <id> <${Object.keys(CATEGORY_HELP).join('|')}> <on|off>\` — pick which lines get relayed.`,
                    `\`${prefix}ap progression <id> <on|off>\` — item sends only when they're progression.`,
                    `\`${prefix}ap skipgoaled <id> <on|off>\` — hide items sent to slots that already finished.`,
                    `\`${prefix}ap infer <id> <on|off>\` — also treat a 100%-checked slot as finished (reads the room tracker).`,
                    `\`${prefix}ap color <id> <on|off>\` — colour item names (desktop and web only).`,
                    `\`${prefix}ap markers <id> <on|off>\` — mark items 🟪 progression, 🟦 useful, 🟥 trap. Works everywhere, mobile included.`,
                    `\`${prefix}ap claim [id] <slot name>\` — tell the bot that slot is yours; it pings you when progression reaches it. Anyone can claim their own.`,
                    `\`${prefix}ap unclaim [id] <slot name>\` — give the slot back.`,
                    `\`${prefix}ap claims [id]\` — who has claimed what.`,
                    `\`${prefix}ap pings [id] <slot name> <${claims.PING_MODES.join('|')}>\` — how much a claimed slot pings you.`,
                    `\`${prefix}ap goals [@user]\` — multiworlds goaled. Releases don't count.`,
                    `\`${prefix}ap leaderboard\` — who has goaled the most.`,
                    `\`${prefix}ap password <id> [password]\` — set or clear the room password (the command message is deleted).`,
                    `\`${prefix}ap retry <id>\` — reconnect a watch the server refused.`
                ].join('\n'));
            }

            const readOnly = ['list', 'status', 'claims', 'goals', 'leaderboard'].includes(action);
            // Claiming is the one thing players do for themselves — gating it behind the owner
            // would mean the owner hand-registering everyone in a 29-slot async. Acting on
            // someone else's behalf is still owner-only, checked per action below.
            const selfService = ['claim', 'unclaim', 'pings'].includes(action);
            if (!readOnly && !selfService && !isOwner(msg)) {
                return say('🔒 Only the bot owner can change Archipelago watches.');
            }

            // A watch id is noise when there is only one room, so it can be left out and the one
            // watch is assumed. In the prefix form that makes the first word ambiguous:
            // `!ap claim 0 ZackWord` gives an id and `!ap claim ZackWord` does not.
            //
            // A leading integer is ALWAYS taken as the id, whether or not a watch currently holds
            // it. Deciding that on whether the id exists looks friendlier and is not: a stale id
            // then reads as the next argument instead, which silently retargets the only watch.
            // `!ap unwatch 999` deleted the one live room, `!ap password 7 hunter2` stored the
            // password "7 hunter2", and `!ap progression 0 on` read the 0 as "off" and inverted
            // the setting. Answering "no watch with ID 7" is recoverable; none of those were.
            //
            // The cost is that a slot literally named "12345" needs the explicit form,
            // `!ap claim <id> 12345`, which is a trade worth making in this direction.
            const watchIds = () => monitor.listWatches().map(entry => entry.watch.id);
            const idToken = interaction || !/^\d+$/.test(String(words[1] || '')) ? null : words[1];
            const hasExplicitId = interaction ? opt('id') !== null : idToken !== null;
            // Where the arguments after the id start, so the rest of the parsing does not have to
            // care whether one was given.
            const argBase = hasExplicitId ? 2 : 1;
            const idFrom = () => {
                if (hasExplicitId) {
                    const value = opt('id');
                    return Number(value !== null ? value : idToken);
                }
                const ids = watchIds();
                return ids.length === 1 ? ids[0] : null;
            };
            const badId = () => say(watchIds().length === 0
                ? `No rooms are being watched yet. \`${prefix}ap watch <room url> <slot name>\` starts one.`
                : `More than one room is being watched, so I need the ID. \`${prefix}ap list\` shows them.`);

            try {
                if (action === 'watch') {
                    const target = opt('room') || (rest.split(/\s+/)[0] || '');
                    const slot = opt('slot') || rest.slice(target.length).trim();
                    const label = opt('label') || null;
                    const password = opt('password') || null;

                    if (!target || !slot) {
                        return say(`Usage: \`${prefix}ap watch <room url|host:port> <slot name>\``);
                    }

                    const status = await say(`🧩 Connecting to \`${target}\` as ${slotLabel(slot)}…`);
                    let watch, outcome, detail;
                    try {
                        ({ watch, outcome, detail } = await monitor.addWatch({
                            target,
                            slot,
                            label,
                            password,
                            channelId: msg.channel.id,
                            guildId: msg.guild ? msg.guild.id : null,
                            addedBy: msg.author ? msg.author.id : null
                        }));
                    } catch (err) {
                        return editQuietly(status, `❌ ${err.message}`);
                    }

                    if (outcome === 'connected') {
                        return editQuietly(status, 
                            `🟢 **Watch #${watch.id}** — connected to \`${detail}\` as ${slotLabel(watch.slot)}.\n` +
                            `The room log will appear here. \`${prefix}ap filter ${watch.id} items off\` if it gets noisy.`
                        );
                    }
                    if (outcome === 'refused') {
                        const hint = /InvalidSlot/i.test(detail)
                            ? `\nThat slot name isn't in this multiworld — it has to match a real player slot exactly.`
                            : /InvalidPassword/i.test(detail)
                                ? `\nThe room wants a password: \`${prefix}ap password ${watch.id} <password>\`.`
                                : '';
                        return editQuietly(status, `🔴 **Watch #${watch.id}** — the server refused the connection (\`${detail}\`).${hint}`);
                    }
                    return editQuietly(status, 
                        `🟡 **Watch #${watch.id}** — saved, but no connection yet${detail ? ` (${detail})` : ''}.\n` +
                        `I'll keep retrying in the background; \`${prefix}ap status ${watch.id}\` to check.`
                    );
                }

                if (action === 'list') {
                    return say({ embeds: [buildListEmbed(monitor.listWatches())] });
                }

                if (action === 'status') {
                    const id = idFrom();
                    if (id === null) return badId();
                    const entries = monitor.listWatches().filter(e => e.watch.id === id);
                    if (entries.length === 0) return say(`No watch with ID ${id}.`);
                    return say({ embeds: [buildListEmbed(entries)] });
                }

                if (action === 'unwatch') {
                    const id = idFrom();
                    if (id === null) return badId();
                    const removed = monitor.removeWatch(id);
                    if (!removed) return say(`No watch with ID ${id}.`);
                    const alsoDropped = removed.releasedClaims
                        ? ` ${removed.releasedClaims} slot claim(s) dropped with it.`
                        : '';
                    return say(`🗑️ Stopped watching **${removed.label}** (#${removed.id}).${alsoDropped}`);
                }

                if (action === 'retry') {
                    const id = idFrom();
                    if (id === null) return badId();
                    const state = monitor.restartWatch(id);
                    if (!state) return say(`No watch with ID ${id}.`);
                    return say(`🔄 Reconnecting **${state.watch.label}** (#${id})…`);
                }

                if (action === 'filter') {
                    const id = idFrom();
                    if (id === null) return badId();
                    const group = String(opt('category') || words[argBase] || '').toLowerCase();
                    const rawToggle = opt('enabled');
                    const toggle = rawToggle !== null ? !!rawToggle
                        : truthy(words[argBase + 1]) ? true
                        : falsy(words[argBase + 1]) ? false
                        : null;

                    if (!monitor.FILTER_GROUPS.includes(group) || toggle === null) {
                        return say(
                            `Usage: \`${prefix}ap filter <id> <${monitor.FILTER_GROUPS.join('|')}> <on|off>\`\n` +
                            Object.entries(CATEGORY_HELP).map(([k, v]) => `• \`${k}\` — ${v}`).join('\n')
                        );
                    }

                    const state = monitor.setFilter(id, group, toggle);
                    if (!state) return say(`No watch with ID ${id}.`);
                    const note = group === 'deaths' ? ' Reconnecting so the DeathLink tag takes effect.' : '';
                    return say(`✅ **${state.watch.label}** (#${id}) — \`${group}\` ${toggle ? 'on' : 'off'}.${note}`);
                }

                // progression / skipgoaled / color all read "<id> <on|off>" the same way.
                const TOGGLES = {
                    progression: {
                        apply: monitor.setProgressionOnly,
                        on: 'only progression item sends will be relayed',
                        off: 'all item sends will be relayed'
                    },
                    skipgoaled: {
                        apply: monitor.setSkipGoaled,
                        on: 'items sent to slots that already finished are hidden',
                        off: 'items sent to finished slots are shown again'
                    },
                    infer: {
                        apply: monitor.setInferFinished,
                        on: 'slots with every location checked also count as finished (read from the room tracker)',
                        off: 'only goaled and released slots count as finished'
                    },
                    color: {
                        apply: monitor.setColor,
                        on: 'items are coloured by class (desktop and web only)',
                        off: 'the log is posted without colour'
                    },
                    markers: {
                        apply: monitor.setMarkers,
                        on: 'progression, useful and trap items are marked with a coloured square (works on mobile)',
                        off: 'items are posted without markers'
                    }
                };

                if (TOGGLES[action]) {
                    const id = idFrom();
                    if (id === null) return badId();
                    const rawToggle = opt('enabled');
                    const toggle = rawToggle !== null ? !!rawToggle
                        : truthy(words[argBase]) ? true
                        : falsy(words[argBase]) ? false
                        : null;
                    if (toggle === null) return say(`Usage: \`${prefix}ap ${action} [id] <on|off>\``);

                    const state = TOGGLES[action].apply(id, toggle);
                    if (!state) return say(`No watch with ID ${id}.`);
                    return say(
                        `✅ **${state.watch.label}** (#${id}) — ${toggle ? TOGGLES[action].on : TOGGLES[action].off}.`
                    );
                }

                // --- slot claims -------------------------------------------------------

                const callerId = msg.author ? msg.author.id : null;
                // Slot names legitimately contain spaces, so the prefix form takes everything
                // after the id as the name — minus any mention, which is a separate argument.
                const slotArg = (from, to) => {
                    const fromSlash = opt('slot');
                    if (fromSlash) return String(fromSlash).trim();
                    return words.slice(from, to).join(' ').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
                };
                const mentionedUser = () => {
                    const fromSlash = opt('user');
                    if (fromSlash) return String(fromSlash);
                    // `mentions.users` is built from the API's mentions array, which includes the
                    // author of a replied-to message whenever the reply ping is left on — its
                    // default. So `!ap claim <slot>` sent as a reply to somebody claimed the slot
                    // for THEM, with no `<@id>` anywhere in the text. `parsedUsers` is the set
                    // discord.js parses out of the message content, which is the question being
                    // asked here. The fallback covers the slash adapter's mentions proxy and the
                    // test fakes, neither of which has the getter.
                    const mentions = msg.mentions;
                    const users = (mentions && mentions.parsedUsers) || (mentions && mentions.users);
                    const first = users && typeof users.first === 'function' ? users.first() : null;
                    return first ? first.id : null;
                };
                // Any reply naming a user echoes an <@id>; none of them should actually ping.

                if (action === 'claim') {
                    const id = idFrom();
                    if (id === null) return badId();
                    const slot = slotArg(argBase);
                    if (!slot) return say(`Usage: \`${prefix}ap claim [id] <slot name>\``);

                    const onBehalf = mentionedUser();
                    if (onBehalf && onBehalf !== callerId && !isOwner(msg)) {
                        return say('🔒 Only the bot owner can claim a slot for someone else.');
                    }
                    const userId = onBehalf || callerId;
                    if (!userId) return say('I could not work out who to claim that for.');

                    // Claiming is open to everyone, so it needs the ownership check that unclaim
                    // and pings carry: without it any player could take a slot somebody else was
                    // already on, silently stopping their pings and inheriting its goals.
                    const existing = monitor.listClaims(id);
                    if (existing === null) return say(`No watch with ID ${id}.`);
                    const heldBy = existing.find(c => claims.sameSlot(c.slot, slot));
                    if (heldBy && heldBy.userId !== userId && !isOwner(msg)) {
                        return say(
                            `🔒 ${slotLabel(heldBy.slot)} is already claimed by <@${heldBy.userId}>. ` +
                            `They can release it with \`${prefix}ap unclaim ${id} ${heldBy.slot}\`, or the bot owner can reassign it.`
                        );
                    }

                    const result = monitor.claimSlot(id, slot, userId);
                    if (!result) return say(`No watch with ID ${id}.`);

                    const { claim, verified } = result;
                    return say(
                        `✅ ${userId === callerId ? 'You are' : `<@${userId}> is`} now on ${slotLabel(claim.slot)} — ` +
                        `pinging for ${PING_HELP[claim.pings]}.` +
                        (verified ? '' : `\n⚠️ I haven't read the room yet, so I couldn't check that name against it.`) +
                        `\nChange that with \`${prefix}ap pings ${id} ${claim.slot} <${claims.PING_MODES.join('|')}>\`.`
                    );
                }

                if (action === 'unclaim' || action === 'pings') {
                    const id = idFrom();
                    if (id === null) return badId();

                    // The ping mode is a closed vocabulary, so it comes off the end of the line
                    // and whatever is left in front of it is the slot name.
                    const slashMode = opt('mode');
                    const tail = String(words[words.length - 1] || '').toLowerCase();
                    const mode = action !== 'pings' ? null
                        : slashMode ? String(slashMode)
                        : claims.PING_MODES.includes(tail) ? tail
                        : null;
                    const slot = action === 'pings' && !slashMode ? slotArg(argBase, -1) : slotArg(argBase);

                    if (!slot || (action === 'pings' && !mode)) {
                        return say(action === 'pings'
                            ? `Usage: \`${prefix}ap pings [id] <slot name> <${claims.PING_MODES.join('|')}>\`\n` +
                              Object.entries(PING_HELP).map(([k, v]) => `• \`${k}\` — ${v}`).join('\n')
                            : `Usage: \`${prefix}ap unclaim [id] <slot name>\``);
                    }

                    const list = monitor.listClaims(id);
                    if (list === null) return say(`No watch with ID ${id}.`);
                    const held = list.find(c => claims.sameSlot(c.slot, slot));
                    if (!held) return say(`Nobody has claimed ${slotLabel(slot)} on watch #${id}.`);
                    if (held.userId !== callerId && !isOwner(msg)) {
                        return say(`🔒 ${slotLabel(held.slot)} is claimed by <@${held.userId}> — only they or the bot owner can change it.`);
                    }

                    if (action === 'unclaim') {
                        const removed = monitor.releaseSlot(id, slot);
                        return say(`🗑️ ${slotLabel(removed.slot)} released — no more pings for it.`);
                    }
                    const updated = monitor.setClaimPings(id, slot, mode);
                    return say(`✅ ${slotLabel(updated.slot)} — pinging for ${PING_HELP[updated.pings]}.`);
                }

                if (action === 'claims') {
                    const id = idFrom();
                    if (id === null) return badId();
                    const list = monitor.listClaims(id);
                    if (list === null) return say(`No watch with ID ${id}.`);
                    if (list.length === 0) {
                        return say(
                            `Nobody has claimed a slot on watch #${id} yet — \`${prefix}ap claim ${id} <slot name>\` takes one.`
                        );
                    }

                    // Fitted to Discord's 2000-character limit rather than to a flat count of 40:
                    // 40 rows of this shape run to roughly 2,070 characters and the send was
                    // rejected outright, so a big room got an error instead of its claim list.
                    const header = `🧩 **Claimed slots on watch #${id}**`;
                    const sorted = [...list].sort((a, b) => a.slot.localeCompare(b.slot));
                    const all = sorted.map(c => `• ${slotLabel(c.slot)} — <@${c.userId}> (${c.pings})`);

                    const budget = 1900 - header.length;
                    const lines = [];
                    let used = 0;
                    for (const line of all) {
                        if (used + line.length + 1 > budget) break;
                        lines.push(line);
                        used += line.length + 1;
                    }
                    if (lines.length < all.length) lines.push(`…and ${all.length - lines.length} more.`);
                    return say(`${header}\n${lines.join('\n')}`);
                }

                if (action === 'goals') {
                    const who = mentionedUser() || callerId;
                    const count = goals.countFor(who);
                    const mine = who === callerId;

                    if (count === 0) {
                        return say(mine
                            ? `You haven't goaled a multiworld yet, or none of the slots you goaled were claimed at the time.`
                            : `<@${who}> has no goals recorded.`);
                    }

                    // Newest first: the recent ones are the ones anybody is asking about.
                    const entries = goals.entriesFor(who)
                        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
                        .slice(0, 15)
                        .map(e => `• ${slotLabel(e.slot || e.key)}`);
                    const more = count > entries.length ? `\n…and ${count - entries.length} more.` : '';

                    return say(
                        `🏁 ${mine ? 'You have' : `<@${who}> has`} goaled **${count}** multiworld${count === 1 ? '' : 's'}.\n` +
                        `${entries.join('\n')}${more}`
                    );
                }

                if (action === 'leaderboard') {
                    const board = goals.leaderboard();
                    if (board.length === 0) {
                        return say('No goals recorded yet. Claim a slot with `' + prefix + 'ap claim` and finish it.');
                    }
                    const lines = leaderboard.renderBoard(
                        board,
                        row => `<@${row.userId}> — **${row.count}**`,
                        { limit: 15 }
                    );
                    return say(`🏁 **Multiworlds goaled**\n${lines.join('\n')}`);
                }

                if (action === 'password') {
                    const typed = interaction ? null : words.slice(argBase).join(' ');
                    const password = opt('password') || typed || null;

                    // The prefix form puts the password in a channel message. Delete it before
                    // anything else can fail and leave it sitting there.
                    if (!interaction && msg.deletable) {
                        try { await msg.delete(); } catch (_) {}
                    }

                    const id = idFrom();
                    if (id === null) return badId();

                    // Clearing has to be asked for in words. Since a leading integer is always
                    // read as the watch id, `!ap password 0` meaning "set it to 0" left nothing
                    // after the id and would otherwise have silently CLEARED the password —
                    // after deleting the only copy of it the user had.
                    if (!interaction && !typed) {
                        return say(
                            `That would clear the password rather than set one. ` +
                            `Use \`${prefix}ap password ${id} clear\` if that is what you meant, ` +
                            `or \`/ap password\` with the field left empty.`
                        );
                    }
                    const clearing = !password || (!interaction && typed.trim().toLowerCase() === 'clear');

                    const state = monitor.setPassword(id, clearing ? null : password);
                    if (!state) return say(`No watch with ID ${id}.`);
                    return say(
                        `🔑 **${state.watch.label}** (#${id}) — password ${clearing ? 'cleared' : 'set'}; reconnecting.`
                    );
                }

                return say(`Unknown sub-command \`${action}\`. Try \`${prefix}ap help\`.`);
            } catch (err) {
                logger.error('!ap failed:', err);
                return say(`❌ ${err.message || 'Something went wrong — check the bot log.'}`);
            }
        }
    }
};
