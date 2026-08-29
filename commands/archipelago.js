// commands/archipelago.js
//
// Front end for the Archipelago room monitor. The bot joins a multiworld as a read-only
// tracker client and relays the server log into the channel the watch was created in.

const { EmbedBuilder } = require('discord.js');
const config = require('../config/config.js');
const logger = require('../helpers/logger.js');
const monitor = require('../helpers/archipelagoMonitor.js');

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
                `**Slot:** \`${watch.slot}\`${watch.password ? ' (password set)' : ''}`,
                `**Room:** ${monitor.describeTarget(watch.target)}`,
                `**Address:** ${entry.address || '—'}`,
                `**Channel:** <#${watch.channelId}>`,
                `**State:** ${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`,
                `**Relayed:** ${entry.lineCount} line(s)${entry.droppedLines ? `, ${entry.droppedLines} dropped` : ''}`,
                `**Showing:** ${filters}${watch.progressionOnly ? ' · progression items only' : ''}`,
                `**Extras:** ${watch.color !== false ? 'colour on' : 'colour off'} · ` +
                    (watch.skipGoaled !== false
                        ? `hiding items to ${entry.goaled || 0} finished slot(s)`
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
        slash: {
            description: 'Watch an Archipelago room and relay its log here',
            subcommands: [
                { name: 'watch', description: 'Start relaying a multiworld log into this channel', options: [
                    { name: 'room', type: 'STRING', required: true, description: 'Room URL, or host:port of the server' },
                    { name: 'slot', type: 'STRING', required: true, description: 'An existing slot name to observe from' },
                    { name: 'label', type: 'STRING', required: false, description: 'Name to show in status output' },
                    { name: 'password', type: 'STRING', required: false, description: 'Room password — visible in channel; prefer !ap password' }
                ] },
                { name: 'list', description: 'Show every room being watched', options: [] },
                { name: 'status', description: 'Show detail for one watch', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' }
                ] },
                { name: 'unwatch', description: 'Stop watching a room', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' }
                ] },
                { name: 'filter', description: 'Turn one category of log line on or off', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' },
                    { name: 'category', type: 'STRING', required: true, description: 'Which lines to toggle', choices: [
                        { name: 'items', value: 'items' },
                        { name: 'hints', value: 'hints' },
                        { name: 'chat', value: 'chat' },
                        { name: 'joins', value: 'joins' },
                        { name: 'goals', value: 'goals' },
                        { name: 'deaths', value: 'deaths' },
                        { name: 'misc', value: 'misc' }
                    ] },
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Show these lines?' }
                ] },
                { name: 'progression', description: 'Relay only progression item sends', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' },
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Progression items only?' }
                ] },
                { name: 'skipgoaled', description: 'Hide items sent to slots that already finished', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' },
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Hide them?' }
                ] },
                { name: 'color', description: 'Colour item names by class', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' },
                    { name: 'enabled', type: 'BOOLEAN', required: true, description: 'Use colour?' }
                ] },
                { name: 'password', description: 'Set or clear a room password', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' },
                    { name: 'password', type: 'STRING', required: false, description: 'Leave empty to clear' }
                ] },
                { name: 'retry', description: 'Reconnect a paused watch', options: [
                    { name: 'id', type: 'INTEGER', required: true, description: 'Watch ID' }
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

            if (!config.archipelagoEnabled) {
                return msg.channel.send(
                    '🧩 The Archipelago monitor is switched off.\n' +
                    'Set `archipelagoEnabled: true` in `config/config.js` and restart the bot to use it.'
                );
            }

            if (!action || action === 'help' || action === 'menu' || action === '?') {
                return msg.channel.send([
                    '🧩 **Archipelago room monitor**',
                    '*Relays a multiworld\'s server log into the channel you set it up in.*',
                    '',
                    `\`${prefix}ap watch <room url|host:port> <slot name>\` — start watching. The slot name is any real slot in the multiworld; the bot attaches as a read-only tracker and never receives items.`,
                    `\`${prefix}ap list\` — every watch and its state.`,
                    `\`${prefix}ap status <id>\` — detail for one watch.`,
                    `\`${prefix}ap unwatch <id>\` — stop and forget a watch.`,
                    `\`${prefix}ap filter <id> <${Object.keys(CATEGORY_HELP).join('|')}> <on|off>\` — pick which lines get relayed.`,
                    `\`${prefix}ap progression <id> <on|off>\` — item sends only when they're progression.`,
                    `\`${prefix}ap skipgoaled <id> <on|off>\` — hide items sent to slots that already finished.`,
                    `\`${prefix}ap color <id> <on|off>\` — colour item names: progression, useful, trap, filler.`,
                    `\`${prefix}ap password <id> [password]\` — set or clear the room password (the command message is deleted).`,
                    `\`${prefix}ap retry <id>\` — reconnect a watch the server refused.`
                ].join('\n'));
            }

            const readOnly = ['list', 'status'].includes(action);
            if (!readOnly && !isOwner(msg)) {
                return msg.channel.send('🔒 Only the bot owner can change Archipelago watches.');
            }

            const idFrom = (token) => {
                const value = opt('id');
                const parsed = Number(value !== null ? value : token);
                return Number.isInteger(parsed) ? parsed : null;
            };
            const badId = () => msg.channel.send(`Which watch? \`${prefix}ap list\` shows the IDs.`);

            try {
                if (action === 'watch') {
                    const target = opt('room') || (rest.split(/\s+/)[0] || '');
                    const slot = opt('slot') || rest.slice(target.length).trim();
                    const label = opt('label') || null;
                    const password = opt('password') || null;

                    if (!target || !slot) {
                        return msg.channel.send(`Usage: \`${prefix}ap watch <room url|host:port> <slot name>\``);
                    }

                    const status = await msg.channel.send(`🧩 Connecting to \`${target}\` as \`${slot}\`…`);
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
                        return status.edit(`❌ ${err.message}`);
                    }

                    if (outcome === 'connected') {
                        return status.edit(
                            `🟢 **Watch #${watch.id}** — connected to \`${detail}\` as \`${watch.slot}\`.\n` +
                            `The room log will appear here. \`${prefix}ap filter ${watch.id} items off\` if it gets noisy.`
                        );
                    }
                    if (outcome === 'refused') {
                        const hint = /InvalidSlot/i.test(detail)
                            ? `\nThat slot name isn't in this multiworld — it has to match a real player slot exactly.`
                            : /InvalidPassword/i.test(detail)
                                ? `\nThe room wants a password: \`${prefix}ap password ${watch.id} <password>\`.`
                                : '';
                        return status.edit(`🔴 **Watch #${watch.id}** — the server refused the connection (\`${detail}\`).${hint}`);
                    }
                    return status.edit(
                        `🟡 **Watch #${watch.id}** — saved, but no connection yet${detail ? ` (${detail})` : ''}.\n` +
                        `I'll keep retrying in the background; \`${prefix}ap status ${watch.id}\` to check.`
                    );
                }

                if (action === 'list') {
                    return msg.channel.send({ embeds: [buildListEmbed(monitor.listWatches())] });
                }

                if (action === 'status') {
                    const id = idFrom(words[1]);
                    if (id === null) return badId();
                    const entries = monitor.listWatches().filter(e => e.watch.id === id);
                    if (entries.length === 0) return msg.channel.send(`No watch with ID ${id}.`);
                    return msg.channel.send({ embeds: [buildListEmbed(entries)] });
                }

                if (action === 'unwatch') {
                    const id = idFrom(words[1]);
                    if (id === null) return badId();
                    const removed = monitor.removeWatch(id);
                    if (!removed) return msg.channel.send(`No watch with ID ${id}.`);
                    return msg.channel.send(`🗑️ Stopped watching **${removed.label}** (#${removed.id}).`);
                }

                if (action === 'retry') {
                    const id = idFrom(words[1]);
                    if (id === null) return badId();
                    const state = monitor.restartWatch(id);
                    if (!state) return msg.channel.send(`No watch with ID ${id}.`);
                    return msg.channel.send(`🔄 Reconnecting **${state.watch.label}** (#${id})…`);
                }

                if (action === 'filter') {
                    const id = idFrom(words[1]);
                    if (id === null) return badId();
                    const group = String(opt('category') || words[2] || '').toLowerCase();
                    const rawToggle = opt('enabled');
                    const toggle = rawToggle !== null ? !!rawToggle
                        : truthy(words[3]) ? true
                        : falsy(words[3]) ? false
                        : null;

                    if (!monitor.FILTER_GROUPS.includes(group) || toggle === null) {
                        return msg.channel.send(
                            `Usage: \`${prefix}ap filter <id> <${monitor.FILTER_GROUPS.join('|')}> <on|off>\`\n` +
                            Object.entries(CATEGORY_HELP).map(([k, v]) => `• \`${k}\` — ${v}`).join('\n')
                        );
                    }

                    const state = monitor.setFilter(id, group, toggle);
                    if (!state) return msg.channel.send(`No watch with ID ${id}.`);
                    const note = group === 'deaths' ? ' Reconnecting so the DeathLink tag takes effect.' : '';
                    return msg.channel.send(`✅ **${state.watch.label}** (#${id}) — \`${group}\` ${toggle ? 'on' : 'off'}.${note}`);
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
                    color: {
                        apply: monitor.setColor,
                        on: 'items are coloured by class (progression, useful, trap, filler)',
                        off: 'the log is posted without colour'
                    }
                };

                if (TOGGLES[action]) {
                    const id = idFrom(words[1]);
                    if (id === null) return badId();
                    const rawToggle = opt('enabled');
                    const toggle = rawToggle !== null ? !!rawToggle
                        : truthy(words[2]) ? true
                        : falsy(words[2]) ? false
                        : null;
                    if (toggle === null) return msg.channel.send(`Usage: \`${prefix}ap ${action} <id> <on|off>\``);

                    const state = TOGGLES[action].apply(id, toggle);
                    if (!state) return msg.channel.send(`No watch with ID ${id}.`);
                    return msg.channel.send(
                        `✅ **${state.watch.label}** (#${id}) — ${toggle ? TOGGLES[action].on : TOGGLES[action].off}.`
                    );
                }

                if (action === 'password') {
                    const password = opt('password') || (interaction ? null : words.slice(2).join(' ')) || null;

                    // The prefix form puts the password in a channel message. Delete it before
                    // anything else can fail and leave it sitting there.
                    if (!interaction && msg.deletable) {
                        try { await msg.delete(); } catch (_) {}
                    }

                    const id = idFrom(words[1]);
                    if (id === null) return badId();

                    const state = monitor.setPassword(id, password);
                    if (!state) return msg.channel.send(`No watch with ID ${id}.`);
                    return msg.channel.send(
                        `🔑 **${state.watch.label}** (#${id}) — password ${password ? 'set' : 'cleared'}; reconnecting.`
                    );
                }

                return msg.channel.send(`Unknown sub-command \`${action}\`. Try \`${prefix}ap help\`.`);
            } catch (err) {
                logger.error('!ap failed:', err);
                return msg.channel.send(`❌ ${err.message || 'Something went wrong — check the bot log.'}`);
            }
        }
    }
};
