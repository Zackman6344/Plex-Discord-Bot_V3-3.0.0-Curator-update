// commands/launch.js
const playnite = require('../helpers/playniteAPI.js');
const config = require('../config/config.js');
const { MessageEmbed } = require('discord.js');

module.exports = {
    name: 'launch',
    command: {
        usage: '!launch [title]',
        description: 'Securely boots a game on the host PC (Owner Only).',
        process: async function(bot, client, msg) {
            if (!msg) return;

            // 1. The Config & Setup Gatekeeper
                        if (!config.playniteEnabled) {
                            return msg.channel.send("❌ **Playnite Integration is currently disabled.**");
                        }

                        if (!config.ownerId || config.ownerId === 'YOUR_DISCORD_ID_HERE' || config.ownerId === '') {
                            return msg.channel.send("⚙️ **Configuration Required:** The bot owner must set their `ownerId` in the config file before Playnite features can be used.");
                        }

                        // 2. THE SECURITY LOCK (Owner + Role Support)
                        const isOwner = msg.author.id === config.ownerId;

                        // Checks if the message was sent in a server, if a role ID is configured, and if the user has that role
                        const hasLaunchRole = msg.member && config.launchRoleId && config.launchRoleId !== 'ROLE_ID_HERE' && msg.member.roles.cache.has(config.launchRoleId);

                        if (!isOwner && !hasLaunchRole) {
                            return msg.channel.send("⛔ **Access Denied:** You must be the bot owner or have the authorized remote-play role to launch games on the host PC.");
                        }

            const args = msg.content.split(' ').slice(1);
            const query = args.join(' ');

            if (!query) {
                return msg.channel.send("⚠️ Please provide a game to launch! (e.g., `!launch Minecraft`)");
            }

            let statusMsg = await msg.channel.send(`🔍 *Locating "**${query}**" on the host PC...*`);

            // Fetch search results
            const results = await playnite.searchGame(query);

            if (results && results.error === 'OFFLINE') {
                return statusMsg.edit("❌ **Playnite is not running!** The host PC cannot receive launch commands.");
            }

            if (!results || results.length === 0) {
                return statusMsg.edit(`❌ Could not find "**${query}**" installed on the system.`);
            }

            let gameToLaunch;

            // 2. THE SELECTION MENU (If multiple matches are found)
            if (results.length > 1) {
                const maxResults = results.slice(0, 10);
                const optionsText = maxResults.map((g, index) => `**${index + 1}.** ${g.Name} (${g.Source || "Local"})`).join('\n');

                const listEmbed = new MessageEmbed()
                    .setColor('#FF0000') // Red for "Action/Launch"
                    .setTitle(`⚠️ Multiple Games Found`)
                    .setDescription(`Please confirm which game you want to **launch**:\n\n${optionsText}`)
                    .setFooter({ text: 'Type a number to launch, or "cancel" to abort. (Times out in 30s)' });

                await statusMsg.edit({ content: " ", embeds: [listEmbed] });

                const filter = m => m.author.id === msg.author.id;

                try {
                    const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
                    const response = collected.first();

                    if (response.content.toLowerCase() === 'cancel') {
                        await statusMsg.delete().catch(() => {});
                        return msg.channel.send("❌ Launch sequence aborted.");
                    }

                    const selection = parseInt(response.content) - 1;
                    if (isNaN(selection) || selection < 0 || selection >= maxResults.length) {
                        await statusMsg.delete().catch(() => {});
                        return msg.channel.send("❌ Invalid selection. Aborted.");
                    }

                    gameToLaunch = maxResults[selection];
                } catch (err) {
                    await statusMsg.delete().catch(() => {});
                    return msg.channel.send("⏳ Request timed out.");
                }
            } else {
                gameToLaunch = results[0];
            }

            // 3. FIRE THE LAUNCH COMMAND
            await statusMsg.edit({ content: `🚀 *Sending boot signal for **${gameToLaunch.Name}**...*`, embeds: [] });

            const launchResponse = await playnite.launchGame(gameToLaunch.Id);

            if (launchResponse && launchResponse.success) {
                await statusMsg.edit(`✅ **Success!** Playnite is now launching **${gameToLaunch.Name}** on the host PC.`);
            } else {
                await statusMsg.edit(`❌ **Failed to launch:** The host PC encountered an error starting the game.`);
            }
        }
    }
};