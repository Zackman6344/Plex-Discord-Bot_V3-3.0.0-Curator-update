// commands/stats.js
const playnite = require('../helpers/playniteAPI.js');
const tautulli = require('../helpers/tautulliAPI.js');
const config = require('../config/config.js');
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'stats',
    command: {
        usage: '!stats',
        description: `Displays global statistics for both Playnite and the ${config.serverName} media server.`,
        slash: {
            description: 'Combined Plex + Tautulli + Playnite statistics'
        },
        process: async function(bot, client, msg) {
            if (!msg) return;

            if (!config.playniteEnabled) return msg.channel.send("❌ **Playnite Integration is currently disabled.**");
            if (!config.ownerId || config.ownerId === 'YOUR_ACTUAL_ID_HERE' || config.ownerId === '') {
                return msg.channel.send("⚙️ **Configuration Required:** The bot owner must set their `ownerId` in the config file.");
            }

            let statusMsg = await msg.channel.send(`📊 *Crunching database numbers for ${config.serverName}...*`);

            const [playniteStats, plexStats] = await Promise.all([
                playnite.getStats(),
                tautulli.getLibraryStats()
            ]);

            if (playniteStats && playniteStats.error === 'OFFLINE') {
                return statusMsg.edit("❌ **Playnite is not running!** Cannot retrieve library statistics.");
            }
            if (!playniteStats) {
                return statusMsg.edit("❌ **Failed to retrieve stats:** The local Playnite API encountered an error.");
            }

            // --- STANDARD MATH ---
            const totalHours = Math.floor(playniteStats.TotalPlaytime / 3600).toLocaleString();
            const playedPercent = playniteStats.TotalGames > 0 ? Math.round((playniteStats.PlayedGames / playniteStats.TotalGames) * 100) : 0;

            let topGamesText = "";
            if (playniteStats.TopGames && playniteStats.TopGames.length > 0) {
                playniteStats.TopGames.forEach((g, index) => {
                    const hrs = (g.Playtime / 3600).toFixed(1);
                    topGamesText += `**${index + 1}.** ${g.Name} - *${hrs} hrs*\n`;
                });
            } else {
                topGamesText = "*No played games found on record.*";
            }

            // --- THE FUN MATH ---
            // 1. Time Well Wasted (Total seconds divided by 86400 seconds in a day)
            const daysWasted = (playniteStats.TotalPlaytime / 86400).toFixed(1);

            // 2. The Hyper-Fixation Ratio
            const topGameName = playniteStats.TopGames.length > 0 ? playniteStats.TopGames[0].Name : "Nothing";
            const topGamePercent = (playniteStats.TotalPlaytime > 0 && playniteStats.TopGames.length > 0)
                ? Math.round((playniteStats.TopGames[0].Playtime / playniteStats.TotalPlaytime) * 100)
                : 0;

            // 3. Backlog Anxiety
            const backlogAnxiety = 100 - playedPercent;

            // 4. Blockbuster Status (Assuming roughly 25 DVD cases fit on a standard living room shelf)
            let physicalShelves = 0;
            if (plexStats) physicalShelves = Math.ceil((plexStats.movies + plexStats.shows) / 25);

            // --- BUILD THE EMBED ---
            const statsEmbed = new EmbedBuilder()
                .setColor('#E5A00D')
                .setTitle(`📊 ${config.serverName} Server Statistics`)
                .setDescription('Global metrics across local gaming and media hosting.')
                .addFields(
                    // PLEX SECTION
                    { name: '🎬 Plex: Total Movies', value: plexStats ? `${plexStats.movies.toLocaleString()}` : 'Offline', inline: true },
                    { name: '📺 Plex: TV Shows', value: plexStats ? `${plexStats.shows.toLocaleString()}` : 'Offline', inline: true },
                    { name: '▶️ Plex: All-Time Streams', value: plexStats ? `${plexStats.streams.toLocaleString()}` : 'Offline', inline: true },

                    { name: '━━━━━━━━━━━━━━━━━━━━', value: '━━━━━━━━━━━━━━━━━━━━', inline: false },

                    // PLAYNITE SECTION
                    { name: '📚 Playnite: Total Games', value: `${playniteStats.TotalGames.toLocaleString()}`, inline: true },
                    { name: '⏱️ Playnite: Total Playtime', value: `${totalHours} Hours`, inline: true },
                    { name: '📈 Playnite: Library Played', value: `${playniteStats.PlayedGames.toLocaleString()} Titles (${playedPercent}%)`, inline: true },
                    { name: '🏆 Top 3 Most Played Games', value: topGamesText, inline: false },

                    { name: '━━━━━━━━━━━━━━━━━━━━', value: '━━━━━━━━━━━━━━━━━━━━', inline: false },

                    // FUN FACTS SECTION
                    {
                        name: `🧠 ${config.serverName} Fun Facts`,
                        value: `• You have spent **${daysWasted} full days** of your life playing PC games.\n` +
                            `• **${topGamePercent}%** of your entire gaming history is just playing *${topGameName}*.\n` +
                            `• Your Backlog Anxiety Index™ is **${backlogAnxiety}%** (Unplayed games).\n` +
                            `• If your Plex library was physical DVDs, you would need **${physicalShelves.toLocaleString()} shelves** to store it.`,
                        inline: false
                    }
                )
                .setFooter({ text: 'Data pulled live from local APIs.' });

            await statusMsg.edit({ content: " ", embeds: [statsEmbed] });
        }
    }
};