// commands/game.js
const playnite = require('../helpers/playniteAPI.js');
const config = require('../config/config.js');
const { MessageEmbed } = require('discord.js');

module.exports = {
    name: 'game',
    command: {
        usage: '!game [title]',
        description: 'Search your library for a specific game and display its deep metadata.',
        process: async function(bot, client, msg) {
            if (!msg) return;

// 1. The Config & Setup Gatekeeper
            if (!config.playniteEnabled) {
                return msg.channel.send("❌ **Playnite Integration is currently disabled** in the bot's config.");
            }

            // Forces the person hosting the bot to configure their ID before the module activates
            if (!config.ownerId || config.ownerId === 'YOUR_DISCORD_ID_HERE' || config.ownerId === '') {
                return msg.channel.send("⚙️ **Configuration Required:** The bot owner must set their `ownerId` in the config file before Playnite features can be used.");
            }

            // Note: We removed the msg.author.id check here! Anyone in the server can now use this command.
            const args = msg.content.split(' ').slice(1);
            const query = args.join(' ');

            if (!query) {
                return msg.channel.send("⚠️ Please provide a game to search for! (e.g., `!game Fallout 4 VR` or `!game X4: Foundations`)");
            }

            let statusMsg = await msg.channel.send(`🔍 *Searching the archives for "**${query}**"...*`);

            // 2. Fetch data from the C# server
            const results = await playnite.searchGame(query);
            if (results && results.error === 'OFFLINE') {
                            return statusMsg.edit("❌ **Playnite is not running!** Please open Playnite on the host PC and try again.");
                        }

            if (!results || results.length === 0) {
                return statusMsg.edit(`❌ Could not find any game matching "**${query}**" in your library.`);
            }

            let game;

// --- 3. THE MULTIPLE RESULTS HANDLER ---
            if (results.length > 1) {

                // Helper function to calculate metadata completeness (out of 5 metrics)
                const getMetadataScore = (g) => {
                    let score = 0;
                    if (g.Description) score++;
                    if (g.CoverImagePath) score++;
                    if (g.Developers && g.Developers.length > 0) score++;
                    if (g.Genres && g.Genres.length > 0) score++;
                    if (g.ReleaseYear) score++;
                    return score;
                };

                // Sort the results so the games with the highest metadata score are at the top
                results.sort((a, b) => getMetadataScore(b) - getMetadataScore(a));

                // Slice the array to max 10 results
                const maxResults = results.slice(0, 10);

                // Format the array into a rich list with Store and Data %
                const optionsText = maxResults.map((g, index) => {
                    const percent = Math.round((getMetadataScore(g) / 5) * 100);
                    const store = g.Source || "Local";

                    return `**${index + 1}.** ${g.Name}\n> 🛒 **${store}** |  📊 **${percent}%** Metadata`;
                }).join('\n\n');

                const listEmbed = new MessageEmbed()
                    .setColor('#202225')
                    .setTitle(`Multiple Games Found for "${query}"`)
                    .setDescription(`Please type the **number** of the game you meant:\n\n${optionsText}`)
                    .setFooter({ text: 'Type a number to select, or "cancel" to abort. (Times out in 30s)' });

                await statusMsg.edit({ content: " ", embeds: [listEmbed] });

                // Set up a listener to wait for the user's next message
                const filter = m => m.author.id === msg.author.id;

                try {
                    // Wait 30 seconds for the user to reply
                    const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
                    const response = collected.first();

                    // If the user types "cancel", shut down the search
                    if (response.content.toLowerCase() === 'cancel') {
                        await statusMsg.delete().catch(() => {});
                        return msg.channel.send("❌ Search cancelled.");
                    }

                    // Convert their text into a number (subtract 1 because arrays start at 0)
                    const selection = parseInt(response.content) - 1;

                    if (isNaN(selection) || selection < 0 || selection >= maxResults.length) {
                        await statusMsg.delete().catch(() => {});
                        return msg.channel.send("❌ Invalid selection. Please run the command again.");
                    }

                    // Assign the chosen game!
                    game = maxResults[selection];

                    await statusMsg.edit({ content: `⏳ *Loading data for **${game.Name}**...*`, embeds: [] });

                } catch (err) {
                    await statusMsg.delete().catch(() => {});
                    return msg.channel.send("⏳ Search timed out. Please run the command again.");
                }
            } else {
                // If there's only 1 exact match, just skip the list and assign it
                game = results[0];
            }

// --- 4. DATA FORMATTING ---

            // Helper function to safely join arrays and prevent Discord's 1024-character field limit
            const formatList = (arr) => {
                if (!arr || arr.length === 0) return 'None';
                const joined = arr.join(', ');
                return joined.length > 1000 ? joined.substring(0, 997) + '...' : joined;
            };

            const playHours = game.Playtime > 0 ? (game.Playtime / 3600).toFixed(1) + " hrs" : "Unplayed";
            const critic = game.CriticScore ? `${game.CriticScore}/100` : "N/A";
            const comm = game.CommunityScore ? `${game.CommunityScore}/100` : "N/A";

            // Clean the HTML from the description and use Discord's massive 4096 character limit
            let cleanDesc = game.Description ? game.Description.replace(/<[^>]*>?/gm, '').trim() : '*No description available.*';
            if (cleanDesc.length > 3900) cleanDesc = cleanDesc.substring(0, 3900) + '\n\n*...[Description Truncated]*';

            // --- 5. BUILD THE MEGA EMBED ---
            const gameEmbed = new MessageEmbed()
                .setColor('#202225')
                .setTitle(`🎮 ${game.Name} (${game.ReleaseYear || 'N/A'})`)
                .setDescription(cleanDesc)
                .addFields(
                    // Row 1: Core Info
                    { name: '🖥️ Platform', value: formatList(game.Platforms), inline: true },
                    { name: '🛠️ Developer', value: formatList(game.Developers), inline: true },
                    { name: '🏢 Publisher', value: formatList(game.Publishers), inline: true },

                    // Row 2: Player Stats
                    { name: '⏱️ Playtime', value: playHours, inline: true },
                    { name: '🏆 Status', value: game.CompletionStatus, inline: true },
                    { name: '⭐ Scores', value: `Critic: ${critic} | Comm: ${comm}`, inline: true },

                    // Row 3: Deep Metadata (Not inline, so they span the whole width)
                    { name: '🏷️ Genres', value: formatList(game.Genres), inline: false },
                    { name: '✨ Features', value: formatList(game.Features), inline: false },
                    { name: '🔖 Tags', value: formatList(game.Tags), inline: false }
                )
                .setFooter({ text: `Source: ${game.Source}` });

            const messageOptions = { content: " ", embeds: [gameEmbed] };

            if (game.CoverImagePath) {
                gameEmbed.setImage('attachment://cover.jpg');
                messageOptions.files = [{
                    attachment: game.CoverImagePath,
                    name: 'cover.jpg'
                }];
            }

            await statusMsg.delete().catch(() => {});
            await msg.channel.send(messageOptions);
        }
    }
};