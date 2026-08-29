// commands/config.js
// Owner-only in-Discord settings wizard. Renders a panel (embed of current values + a select
// menu); picking a setting edits it via a modal (text/number), buttons (on/off), or a small
// select (choice). Saves go through helpers/configStore.js — persisted to
// data/config.overrides.json and applied to the live config object immediately (most settings
// take effect without a restart; the few that don't are marked).
//
// Component/modal handling is self-contained via a message component collector +
// awaitModalSubmit (same pattern as commands/buildcharacter.js), so no global interaction
// router changes are needed.
const {
    EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('../config/config.js');
const store = require('../helpers/configStore.js');
const logger = require('../helpers/logger.js');

const PANEL_COLOR = 0x5865F2;
const COLLECTOR_MS = 2 * 60 * 1000;

function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function panelEmbed(statusLine, bootstrapMode) {
    const embed = new EmbedBuilder().setColor(PANEL_COLOR).setTitle('⚙️ Bot configuration');

    let desc = statusLine ? statusLine + '\n\n' : '';
    if (bootstrapMode) {
        desc += '⚠️ **No owner set** — anyone can use this until you set **Owner Discord ID**.\n\n';
    }
    desc += 'Pick a setting from the menu below to change it.';
    embed.setDescription(desc);

    for (const group of store.GROUPS) {
        const lines = store.SETTINGS
            .filter((s) => s.group === group)
            .map((s) => {
                const restart = s.restartRequired ? ' *(restart)*' : '';
                return `**${s.label}:** ${store.formatValue(s, config[s.key])}${restart}`;
            });
        if (lines.length) embed.addFields({ name: group, value: lines.join('\n') });
    }

    embed.setFooter({ text: 'Changes save instantly and persist across restarts. Items marked (restart) apply on next boot.' });
    return embed;
}

function pickRows() {
    return store.selectPages().map((page, index) =>
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`cfg_pick_${index}`)
                .setPlaceholder(`Edit a ${page.label} setting…`)
                .addOptions(page.settings.map((s) => ({
                    label: truncate(s.label, 100),
                    value: s.key,
                    description: truncate(`${s.group} · now: ${store.formatValue(s, config[s.key])}`, 100),
                })))
        )
    );
}

function closeRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg_close').setLabel('Close').setStyle(ButtonStyle.Secondary)
    );
}

function backCloseRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg_cancel').setLabel('Back').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cfg_close').setLabel('Close').setStyle(ButtonStyle.Secondary)
    );
}

function boolComponents() {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cfg_bool_enable').setLabel('Enable').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cfg_bool_disable').setLabel('Disable').setStyle(ButtonStyle.Danger)
    );
    return [row, backCloseRow()];
}

function choiceComponents(setting) {
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cfg_choice')
            .setPlaceholder(`Choose ${truncate(setting.label, 80)}…`)
            .addOptions(setting.choices.map((c) => ({ label: truncate(c.label, 100), value: c.value })))
    );
    return [row, backCloseRow()];
}

function pickComponents() {
    return [...pickRows(), closeRow()];
}

function buildModal(setting) {
    const modal = new ModalBuilder()
        .setCustomId(`cfg_modal_${setting.key}`)
        .setTitle(truncate(`Edit ${setting.label}`, 45));

    const input = new TextInputBuilder()
        .setCustomId('cfg_input')
        .setLabel(truncate(setting.label, 45))
        .setStyle(TextInputStyle.Short)
        .setRequired(setting.allowEmpty === false);

    if (setting.warn) input.setPlaceholder(truncate(setting.warn, 100));
    else if (setting.placeholder) input.setPlaceholder(truncate(setting.placeholder, 100));

    // Prefill the current value for non-secrets so editing is easy; secrets always start blank.
    if (!setting.secret) {
        const cur = String(config[setting.key] ?? '');
        if (cur) input.setValue(cur.slice(0, 4000));
    }

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function confirmLine(setting) {
    let line = `✅ **${setting.label}** updated.`;
    if (setting.restartRequired) line += ' ⚠️ Applies after the next restart.';
    if (setting.warn) line += `\n⚠️ ${setting.warn}`;
    return line;
}

module.exports = {
    name: 'config',
    command: {
        usage: '',
        description: 'Owner-only: view and change bot settings from Discord.',
        slash: {
            description: 'View and change bot settings (owner only)',
            ephemeral: true,
        },
        process: async function (bot, client, message) {
            if (!message) return;

            const configuredOwner = config.ownerId;
            const bootstrapMode = !configuredOwner || configuredOwner === '';

            if (!bootstrapMode && message.author.id !== configuredOwner) {
                return message.reply('⛔ **Owner only.** Only the configured bot owner can change settings.');
            }

            let activeKey = null;

            const panelMsg = await message.reply({
                embeds: [panelEmbed(null, bootstrapMode)],
                components: pickComponents(),
            });

            const collector = panelMsg.createMessageComponentCollector({
                filter: (i) => i.user.id === message.author.id,
                time: COLLECTOR_MS,
            });

            const renderPick = async (interaction, status) => {
                activeKey = null;
                await interaction.update({ embeds: [panelEmbed(status, bootstrapMode)], components: pickComponents() });
            };

            collector.on('collect', async (i) => {
                try {
                    if (i.customId === 'cfg_close') {
                        collector.stop('closed');
                        await i.update({ embeds: [panelEmbed('✅ Closed.', bootstrapMode)], components: [] });
                        return;
                    }

                    if (i.customId === 'cfg_cancel') {
                        return renderPick(i);
                    }

                    // One menu per settings group, so the id carries which menu was used.
                    if (i.customId.startsWith('cfg_pick')) {
                        const setting = store.getSetting(i.values[0]);
                        if (!setting) return renderPick(i);
                        activeKey = setting.key;

                        if (setting.type === 'bool') {
                            return i.update({
                                embeds: [panelEmbed(`Toggle **${setting.label}** (now ${store.formatValue(setting, config[setting.key])}):`, bootstrapMode)],
                                components: boolComponents(),
                            });
                        }
                        if (setting.type === 'choice') {
                            return i.update({
                                embeds: [panelEmbed(`Choose a value for **${setting.label}**:`, bootstrapMode)],
                                components: choiceComponents(setting),
                            });
                        }

                        // string / int / secret → modal
                        await i.showModal(buildModal(setting));
                        const submitted = await i
                            .awaitModalSubmit({
                                time: COLLECTOR_MS,
                                filter: (m) => m.customId === `cfg_modal_${setting.key}` && m.user.id === i.user.id,
                            })
                            .catch(() => null);
                        if (!submitted) return; // dismissed / timed out — leave the panel as-is

                        const raw = submitted.fields.getTextInputValue('cfg_input');
                        const res = store.validate(setting, raw);
                        if (res.error) {
                            return submitted.reply({ content: `❌ ${res.error}`, ephemeral: true });
                        }
                        store.writeOverride(setting.key, res.value);
                        activeKey = null;
                        return submitted.update({ embeds: [panelEmbed(confirmLine(setting), bootstrapMode)], components: pickComponents() });
                    }

                    if (i.customId === 'cfg_bool_enable' || i.customId === 'cfg_bool_disable') {
                        const setting = store.getSetting(activeKey);
                        if (!setting) return renderPick(i);
                        store.writeOverride(setting.key, i.customId === 'cfg_bool_enable');
                        return renderPick(i, confirmLine(setting));
                    }

                    if (i.customId === 'cfg_choice') {
                        const setting = store.getSetting(activeKey);
                        if (!setting) return renderPick(i);
                        const res = store.validate(setting, i.values[0]);
                        if (res.error) return renderPick(i, `❌ ${res.error}`);
                        store.writeOverride(setting.key, res.value);
                        return renderPick(i, confirmLine(setting));
                    }
                } catch (err) {
                    logger.error('config wizard interaction failed:', err.message || err);
                }
            });

            collector.on('end', async (_collected, reason) => {
                if (reason === 'closed') return;
                // Best-effort: grey out the panel after the timeout. Ephemeral edits can fail; ignore.
                try {
                    await panelMsg.edit({ components: [] });
                } catch (_) { /* ignore */ }
            });
        },
    },
};
