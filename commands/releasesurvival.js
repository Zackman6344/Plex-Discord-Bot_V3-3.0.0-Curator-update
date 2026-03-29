const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const fs = require('fs');
const path = require('path');

const plex = new PlexAPI({
    hostname: plexConfig.hostname,
    port: plexConfig.port,
    https: plexConfig.https,
    token: plexConfig.token,
    options: plexConfig.options
});

// THE FIX: Dynamic Leaderboard File Paths
function getLeaderboardFile(category) {
    return path.join(__dirname, `../config/survival_${category}_leaderboard.json`);
}

function loadLeaderboard(category) {
    const file = getLeaderboardFile(category);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveLeaderboard(category, data) {
    const file = getLeaderboardFile(category);
    fs.writeFileSync(file, JSON.stringify(data, null, 4));
}

// Global state tracker
const activeGames = new Map();

module.exports = {
    name: 'releasesurvival',
    command: {
        usage: '!releasesurvival [start] [movies/shows/albums]',
        description: 'A rapid-fire Higher or Lower release year survival game.',
        process: async function(...args) {
            let msg = null;
            let commandArgs = [];

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                } else if (typeof arg === 'string') {
                    commandArgs.push(arg);
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            const rawInput = commandArgs.join(" ").trim().toLowerCase();
            const words = rawInput.split(" ");
            const firstWord = words[0];
            const channelId = msg.channel.id;
            const playerId = msg.author.id;

            // ==========================================
            // MAIN MENU
            // ==========================================
            if (!firstWord || firstWord === 'menu' || firstWord === 'help') {
                const menuText = `
🔥 **Release Survival - Main Menu** 🔥
*A rapid-fire game of Higher or Lower! I give you a title, and you guess if the next one came out BEFORE or AFTER.*

**Commands:**
▶️ \`!releasesurvival start movies\`
▶️ \`!releasesurvival start shows\`
▶️ \`!releasesurvival start albums\`
🛑 \`!releasesurvival stop\` - Bails out of your current run.
🏆 \`!releasesurvival leaderboard\` - View the top 3 of all categories.
🏆 \`!releasesurvival leaderboard [category]\` - View the top 10 of a specific category.

*Tip: You can type "Before/After" or "Older/Newer" during the game!*
                `;
                return msg.channel.send(menuText.trim());
            }

            // ==========================================
            // THE LEADERBOARD DISPLAY
            // ==========================================
            if (firstWord === 'leaderboard' || firstWord === 'stats') {
                const targetCategory = words[1];
                const validCategories = ['movies', 'shows', 'albums'];

                // Deep Dive Leaderboard (Specific Category)
                if (targetCategory && validCategories.includes(targetCategory)) {
                    const board = loadLeaderboard(targetCategory);
                    const players = Object.values(board).sort((a, b) => b.highScore - a.highScore);

                    if (players.length === 0) {
                        return msg.channel.send(`🏆 **${targetCategory.toUpperCase()} Survival Leaderboard** 🏆\n*It's empty! Run \`!releasesurvival start ${targetCategory}\` to set the first high score.*`);
                    }

                    let boardText = `🏆 **${targetCategory.toUpperCase()} Survival Leaderboard** 🏆\n\n`;
                    players.slice(0, 10).forEach((p, index) => {
                        let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                        boardText += `${medal} **${p.username}**: ${p.highScore} correct in a row\n`;
                    });
                    return msg.channel.send(boardText);
                }
                // Summary Leaderboard (All Categories)
                else {
                    let boardText = "🏆 **Release Survival Leaderboards** 🏆\n*Type \`!releasesurvival leaderboard [category]\` for full lists.*\n\n";

                    validCategories.forEach(cat => {
                        const board = loadLeaderboard(cat);
                        const players = Object.values(board).sort((a, b) => b.highScore - a.highScore);

                        boardText += `🎬 **${cat.toUpperCase()}**\n`;
                        if (players.length === 0) {
                            boardText += `> *No scores recorded yet.*\n\n`;
                        } else {
                            players.slice(0, 3).forEach((p, index) => {
                                let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉";
                                boardText += `> ${medal} **${p.username}**: ${p.highScore}\n`;
                            });
                            boardText += `\n`;
                        }
                    });
                    return msg.channel.send(boardText.trim());
                }
            }

            // ==========================================
            // COMMAND ROUTING
            // ==========================================
            if (firstWord === 'stop') {
                if (activeGames.has(playerId)) {
                    activeGames.get(playerId).collector.stop('force_stop');
                    activeGames.delete(playerId);
                    return msg.channel.send(`🛑 <@${playerId}> bailed out of their survival run.`);
                }
                return msg.channel.send("⚠️ *You don't have an active survival run to stop.*");
            }

            if (firstWord !== 'start') {
                return msg.channel.send("⚠️ *Unknown command. Type \`!releasesurvival\` to see the Main Menu!*");
            }

            if (activeGames.has(playerId)) {
                return msg.channel.send("⚠️ *You are already in a survival run! Finish it or type \`!releasesurvival stop\`.*");
            }

            const category = words[1];
            const validCategories = ['movies', 'shows', 'albums'];

            if (!validCategories.includes(category)) {
                return msg.channel.send("⚠️ *Please choose a valid category: \`movies\`, \`shows\`, or \`albums\`.*");
            }

            // ==========================================
            // STARTING A NEW GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`🔥 **Loading the Vault...**\n⏳ *Pulling ${category} metadata...*`);

            try {
                const sections = await plex.query('/library/sections');
                let targetSections = [];

                if (category === 'movies') {
                    targetSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie');
                } else if (category === 'shows') {
                    targetSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'show');
                } else if (category === 'albums') {
                    targetSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'artist');
                }

                if (targetSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any libraries matching ${category}!`);
                }

                let allItems = [];
                for (const sec of targetSections) {
                    let endpoint = `/library/sections/${sec.key}/all`;
                    if (category === 'albums') endpoint += '?type=9';

                    const libraryData = await plex.query(endpoint);
                    const items = libraryData.MediaContainer.Metadata || [];
                    allItems = allItems.concat(items);
                }

                let validItems = allItems.filter(item => item.year || item.parentYear);

                if (validItems.length < 10) {
                    return statusMsg.edit(`❌ You don't have enough metadata in your ${category} library to play this game!`);
                }

                await statusMsg.delete().catch(() => {});

                const formatItem = (item) => {
                    let title = item.title;
                    if (category === 'albums' && item.parentTitle) {
                        title = `${item.title} (by ${item.parentTitle})`;
                    }
                    return {
                        title: title,
                        year: parseInt(item.year || item.parentYear)
                    };
                };

                let streak = 0;
                let currentItem = formatItem(validItems[Math.floor(Math.random() * validItems.length)]);
                let nextItem = null;

                const getNextItem = () => {
                    let candidate = null;
                    while (!candidate || candidate.year === currentItem.year) {
                        candidate = formatItem(validItems[Math.floor(Math.random() * validItems.length)]);
                    }
                    return candidate;
                };

                nextItem = getNextItem();

                let gamePrompt = await msg.channel.send(`🚨 **RELEASE SURVIVAL HAS BEGUN!** 🚨\n<@${playerId}>, you have 30 seconds per round to answer.\n\n🎬 **${currentItem.title}** came out in **${currentItem.year}**.\n\nDid **${nextItem.title}** come out BEFORE or AFTER?`);

                const filter = m => m.author.id === playerId && ['before', 'after', 'older', 'newer', 'higher', 'lower'].includes(m.content.toLowerCase());
                const collector = msg.channel.createMessageCollector({ filter, time: 30000 });

                activeGames.set(playerId, { collector });

                collector.on('collect', async m => {
                    const guess = m.content.toLowerCase();
                    const isBefore = nextItem.year < currentItem.year;
                    const isAfter = nextItem.year > currentItem.year;

                    const guessedBefore = ['before', 'older', 'lower'].includes(guess);
                    const guessedAfter = ['after', 'newer', 'higher'].includes(guess);

                    if ((guessedBefore && isBefore) || (guessedAfter && isAfter)) {
                        streak++;
                        currentItem = nextItem;
                        nextItem = getNextItem();

                        collector.resetTimer();

                        await gamePrompt.edit(`✅ **Correct!** (${currentItem.year})\n\n🔥 **Streak:** ${streak}\n🎬 **${currentItem.title}** came out in **${currentItem.year}**.\n\nDid **${nextItem.title}** come out BEFORE or AFTER?`);
                        m.delete().catch(() => {});
                    } else {
                        collector.stop('lost');
                        m.delete().catch(() => {});
                    }
                });

                collector.on('end', async (collected, reason) => {
                    activeGames.delete(playerId);

                    if (reason === 'force_stop') return;

                    let finalMessage = "";
                    if (reason === 'time') {
                        finalMessage = `🕰️ **You took too long!** The survival run is over.\n**${nextItem.title}** came out in **${nextItem.year}**.`;
                    } else if (reason === 'lost') {
                        finalMessage = `❌ **Wrong!**\n**${nextItem.title}** came out in **${nextItem.year}**.`;
                    }

                    // THE FIX: Save to the category-specific leaderboard
                    const board = loadLeaderboard(category);
                    let newHighScore = false;

                    if (!board[playerId]) {
                        board[playerId] = { username: msg.author.username, highScore: 0 };
                    }

                    if (streak > board[playerId].highScore) {
                        board[playerId].highScore = streak;
                        board[playerId].username = msg.author.username;
                        newHighScore = true;
                        saveLeaderboard(category, board);
                    }

                    let scoreReport = `\n\n🔥 **Final Streak:** ${streak}`;
                    if (newHighScore && streak > 0) {
                        scoreReport += `\n🌟 **NEW PERSONAL BEST!**`;
                    } else {
                        scoreReport += `\n*(Personal Best: ${board[playerId].highScore})*`;
                    }

                    await gamePrompt.edit(finalMessage + scoreReport);
                });

            } catch (err) {
                console.error(err);
                statusMsg.edit("❌ *The vault doors jammed. Try running the command again!*").catch(() => {});
            }
        }
    }
};