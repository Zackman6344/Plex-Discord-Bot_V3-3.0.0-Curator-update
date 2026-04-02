// commands/backlog.js
const playnite = require('../helpers/playniteAPI.js');
const { MessageEmbed } = require('discord.js');
const config = require('../config/config.js');

module.exports = {
    name: 'backlog',
    command: {
        usage: '!backlog',
        description: 'Randomly selects an unplayed game from your Playnite library.',
        process: async function(bot, client, msg) {
                if (!config.playniteEnabled) {
                    return msg.channel.send("❌ **Playnite Integration is currently disabled** in the bot's config.");
                }
                // 1. The Config & Setup Gatekeeper
                            if (!config.playniteEnabled) {
                                return msg.channel.send("❌ **Playnite Integration is currently disabled** in the bot's config.");
                            }

                            // Forces the person hosting the bot to configure their ID before the module activates
                            if (!config.ownerId || config.ownerId === 'YOUR_DISCORD_ID_HERE' || config.ownerId === '') {
                                return msg.channel.send("⚙️ **Configuration Required:** The bot owner must set their `ownerId` in the config file before Playnite features can be used.");
                            }

                            // Note: We removed the msg.author.id check here! Anyone in the server can now use this command.
            if (!msg) return;

            let statusMsg = await msg.channel.send("🎲 *Digging through your Playnite library...*");

            const library = await playnite.getLibrary();

            if (!library) {
                return statusMsg.edit("❌ **Error:** Could not connect to Playnite. Make sure the app is running on the host PC!");
            }

            // Playnite stores playtime in seconds. Filter for games with 0 playtime.
            const unplayedGames = library.filter(game => game.Playtime === 0);

            if (unplayedGames.length === 0) {
                return statusMsg.edit("🏆 **Incredible!** You have 0 unplayed games. You beat the backlog!");
            }

            // Pick a random unplayed game
            const randomPick = unplayedGames[Math.floor(Math.random() * unplayedGames.length)];

            // Format an embed to look nice
            const gameEmbed = new MessageEmbed()
                .setColor('#FF5733') // Playnite orange
                .setTitle('🎮 The Backlog Chooser Has Spoken')
                .setDescription(`Stop scrolling and go play:\n\n**${randomPick.Name}**`)
                .setFooter({ text: `Chosen from ${unplayedGames.length} unplayed games.` });

            await statusMsg.edit({ content: " ", embeds: [gameEmbed] });
        }
    }
};