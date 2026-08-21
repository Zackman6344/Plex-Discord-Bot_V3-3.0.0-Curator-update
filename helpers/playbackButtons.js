// helpers/playbackButtons.js
//
// Builds the playback button row attached to the "now playing" embed in
// app/bot.js, and dispatches button-click interactions through the same
// command process functions used by the prefix and slash paths. Buttons are
// stateless — they always operate on the current bot.songQueue[0], so a click
// on a scrolled-up old now-playing embed still controls the active player.
// That's the same model OS-level media controls use.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('./logger.js');
const { adaptInteraction } = require('./interactionAdapter.js');

const NAMESPACE = 'playback';

const ACTION_TO_COMMAND = {
    skip:    'skip',
    shuffle: 'shuffle',
    queue:   'viewqueue',
    stop:    'stop',
    // pausetoggle resolves to 'pause' or 'resume' at click time, based on
    // bot.isPaused — the button's rendered label can lag the actual state if
    // the bot is paused/resumed from elsewhere, but the handler re-checks.
};

/**
 * Build the playback control row. Pause/Resume label reflects current state
 * at render time; the click handler re-checks so a stale label is still safe.
 */
function buildRow(bot) {
    const paused = !!bot.isPaused;

    const skip = new ButtonBuilder()
        .setCustomId(`${NAMESPACE}:skip`)
        .setEmoji('⏭️')
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary);

    const pauseToggle = new ButtonBuilder()
        .setCustomId(`${NAMESPACE}:pausetoggle`)
        .setEmoji(paused ? '▶️' : '⏸️')
        .setLabel(paused ? 'Resume' : 'Pause')
        .setStyle(ButtonStyle.Primary);

    const shuffle = new ButtonBuilder()
        .setCustomId(`${NAMESPACE}:shuffle`)
        .setEmoji('🔀')
        .setLabel('Shuffle')
        .setStyle(ButtonStyle.Secondary);

    const queue = new ButtonBuilder()
        .setCustomId(`${NAMESPACE}:queue`)
        .setEmoji('📋')
        .setLabel('Queue')
        .setStyle(ButtonStyle.Secondary);

    const stop = new ButtonBuilder()
        .setCustomId(`${NAMESPACE}:stop`)
        .setEmoji('⏹️')
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder().addComponents(skip, pauseToggle, shuffle, queue, stop);
}

/**
 * Dispatch a button-click interaction to the matching command's process fn,
 * reusing the slash interaction adapter so existing commands work unchanged.
 *
 * @returns {Promise<boolean>} true if the customId belonged to this module
 *   (handled or attempted), false if the dispatcher should keep looking.
 */
async function handle(interaction, bot, client, plexCommands, { onInteractionResponse = null } = {}) {
    if (typeof interaction.customId !== 'string') return false;
    const [namespace, action] = interaction.customId.split(':');
    if (namespace !== NAMESPACE) return false;

    let cmdName = ACTION_TO_COMMAND[action];
    if (action === 'pausetoggle') {
        cmdName = bot.isPaused ? 'resume' : 'pause';
    }
    if (!cmdName) {
        try { await interaction.reply({ content: '❌ Unknown playback action.', ephemeral: true }); } catch (_) {}
        return true;
    }

    const cmd = plexCommands[cmdName];
    if (!cmd) {
        try { await interaction.reply({ content: `❌ Command "${cmdName}" not registered.`, ephemeral: true }); } catch (_) {}
        return true;
    }

    try {
        await interaction.deferReply();
    } catch (err) {
        logger.error(`Button defer failed for ${interaction.customId}:`, err.message || err);
        return true;
    }

    const fakeMessage = adaptInteraction(interaction, '', { onInteractionResponse });
    try {
        await cmd.process(bot, client, fakeMessage, '');
    } catch (err) {
        logger.error(`Button handler for "${cmdName}" threw:`, err);
        try {
            await interaction.followUp({ content: '❌ Command failed — check the bot log.', ephemeral: true });
        } catch (_) {}
    }
    return true;
}

module.exports = { buildRow, handle };
