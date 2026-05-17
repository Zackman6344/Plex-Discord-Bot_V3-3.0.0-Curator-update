// commands/playlist.js/plex-list.js
//
// Lists audio playlists on Plex.
//
//   !playlist plex-list             → lists playlists for the bot's default account
//   !playlist plex-list <username>  → lists playlists for a managed user (PIN prompted via DM)

const plexHome = require('../../helpers/plexHome.js');
const logger = require('../../helpers/logger.js');

const DM_TIMEOUT_MS = 120000;

async function promptDM(dmChannel, userId, question) {
    await dmChannel.send(question);
    const filter = m => m.author.id === userId;
    const collected = await dmChannel.awaitMessages({ filter, max: 1, time: DM_TIMEOUT_MS });
    if (collected.size === 0) return null;
    const reply = collected.first().content.trim();
    if (['cancel', 'abort', 'stop', 'quit'].includes(reply.toLowerCase())) return null;
    return reply;
}

function renderPlaylistEmbed(bot, plexPlaylists) {
    const embedObj = {
        color: 4251856,
        fields: [
            { name: bot.language.NAME, value: '', inline: true },
            { name: bot.language.SONGS, value: '', inline: true }
        ],
        footer: { text: '' }
    };
    plexPlaylists.forEach(entry => {
        embedObj.fields[0].value += entry.title + '\n';
        embedObj.fields[1].value += (entry.leafCount || '?') + '\n';
    });
    return embedObj;
}

module.exports = {
    name: 'plex-list',
    command: {
        usage: '[managed-user]',
        description: 'List Plex audio playlists. With no argument, shows the bot account\'s playlists. With a managed-user name, prompts for a PIN via DM and shows that user\'s playlists.',
        process: async function(bot, client, message, args) {
            const accountName = Array.isArray(args) && args.length > 0 ? args[0] : null;

            // Default account: keep the existing behavior — direct query, in-channel response.
            if (!accountName) {
                try {
                    const plexPlaylists = await bot.listPlaylist(message);
                    const embedObj = renderPlaylistEmbed(bot, plexPlaylists);
                    return message.channel.send({ content: `\n**${bot.language.PLAYLIST} :**\n\n`, embeds: [embedObj] });
                } catch (err) {
                    logger.error('plex-list (default account) failed:', err);
                    return message.reply('No playlists exist on Plex (for the bot\'s default account).');
                }
            }

            // Account specified — needs the Plex Home switch flow.
            const plexConfig = require('../../config/plex.js');
            if (!plexConfig.homeOwnerToken) {
                return message.reply(
                    '⚠️ Listing another account\'s playlists needs `homeOwnerToken` set in `config/plex.js`.'
                );
            }

            // Verify the account exists before we DM the user — fail fast on typos.
            let targetUser;
            try {
                targetUser = await plexHome.findUserByName(accountName);
            } catch (err) {
                return message.reply(`❌ Could not query Plex Home: ${err.message || err}`);
            }
            if (!targetUser) {
                return message.reply(`❌ No managed user named "${accountName}".`);
            }

            let dmChannel;
            try {
                dmChannel = await message.author.createDM();
            } catch (_) {
                return message.reply('❌ I could not DM you. Check your privacy settings and try again.');
            }
            await message.channel.send(`📬 <@${message.author.id}>, check your DMs — I need a PIN to access ${targetUser.username}'s playlists.`);

            // Try cached client first; only DM-prompt if necessary.
            let plex = plexHome.getCachedClient(message.author.id, targetUser.username);
            if (!plex) {
                const pin = await promptDM(
                    dmChannel,
                    message.author.id,
                    `🔑 Enter the PIN for **${targetUser.username}**.\n*(Type \`cancel\` to abort.)*`
                );
                if (pin === null) return dmChannel.send('🕰️ Cancelled.');
                try {
                    plex = await plexHome.switchAs(targetUser.username, pin, message.author.id);
                } catch (err) {
                    return dmChannel.send(`❌ ${err.message || err}`);
                }
                await dmChannel.send('✅ Switched. Posting the playlist list in the channel...');
            }

            try {
                const res = await plex.query('/playlists?playlistType=audio&X-Plex-Container-Start=0&X-Plex-Container-Size=100');
                const playlists = (res.MediaContainer && res.MediaContainer.Metadata) || [];
                if (!playlists.length) {
                    return message.channel.send(`📋 **${targetUser.username}** has no audio playlists.`);
                }
                const embedObj = renderPlaylistEmbed(bot, playlists);
                return message.channel.send({
                    content: `\n**${targetUser.username}'s ${bot.language.PLAYLIST} :**\n\n`,
                    embeds: [embedObj]
                });
            } catch (err) {
                logger.error(`plex-list (account=${targetUser.username}) failed:`, err);
                return message.channel.send(`❌ Could not list playlists for ${targetUser.username}: ${err.message || err}`);
            }
        }
    }
};
