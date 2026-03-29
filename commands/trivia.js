const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(keys.geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

const plex = new PlexAPI({
    hostname: plexConfig.hostname,
    port: plexConfig.port,
    https: plexConfig.https,
    token: plexConfig.token,
    options: plexConfig.options
});

// A helper function to strip punctuation for extremely forgiving answer checking
const cleanString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '').trim();

// Leaderboard File Path
const leaderboardFile = path.join(__dirname, '../config/trivia_leaderboard.json');

// Helper to load the leaderboard from the disk
function loadLeaderboard() {
    if (!fs.existsSync(leaderboardFile)) return {};
    return JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
}

// Helper to save the leaderboard to the disk
function saveLeaderboard(data) {
    fs.writeFileSync(leaderboardFile, JSON.stringify(data, null, 4));
}

module.exports = {
    name: 'trivia',
    command: {
        usage: '!trivia [optional: "leaderboard"]',
        description: 'Start a 3-minute trivia game, or view the server leaderboard.',
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

            const subCommand = commandArgs.join(" ").trim().toLowerCase();

            // ==========================================
            // THE LEADERBOARD DISPLAY
            // ==========================================
            if (subCommand === 'leaderboard' || subCommand === 'stats') {
                const board = loadLeaderboard();
                const players = Object.values(board).sort((a, b) => b.score - a.score);

                if (players.length === 0) {
                    return msg.channel.send("🏆 **Vault Trivia Leaderboard** 🏆\n*It's empty! Nobody has scored any points yet. Run `!trivia` to start a game!*");
                }

                let boardText = "🏆 **Vault Trivia Leaderboard** 🏆\n\n";
                players.slice(0, 10).forEach((p, index) => {
                    let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                    boardText += `${medal} **${p.username}**: ${p.score} pts\n`;
                });

                return msg.channel.send(boardText);
            }

            // ==========================================
            // THE TRIVIA GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`🎲 **Vault Trivia Initializing...**\n⏳ *Rummaging through the server for a random target...*`);

            try {
                const sections = await plex.query('/library/sections');
                const validSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie' || sec.type === 'show');

                if (validSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any Movie or TV Show libraries to pull trivia from!`);
                }

                const randomSection = validSections[Math.floor(Math.random() * validSections.length)];

                await statusMsg.edit(`🎲 **Vault Trivia Initializing...**\n⏳ *Targeting the ${randomSection.title} library...*`);

                const libraryData = await plex.query(`/library/sections/${randomSection.key}/all`);
                const allItems = libraryData.MediaContainer.Metadata || [];

                if (allItems.length === 0) {
                    return statusMsg.edit(`❌ The ${randomSection.title} library is empty!`);
                }

                let target = null;
                let attempts = 0;
                while (!target && attempts < 50) {
                    let randomItem = allItems[Math.floor(Math.random() * allItems.length)];
                    if (randomItem.summary && randomItem.title) {
                        target = randomItem;
                    }
                    attempts++;
                }

                if (!target) {
                    return statusMsg.edit(`❌ I couldn't find an item with enough metadata to build a trivia question!`);
                }

                const targetType = target.type === 'show' ? 'TV Show' : 'Movie';
                const cleanTargetTitle = cleanString(target.title);

                await statusMsg.edit(`🎲 **Vault Trivia Initializing...**\n⏳ *Target locked. The AI Game Master is writing the clues...*`);

                const triviaPrompt = `
                You are a sarcastic, witty trivia host running a game for a Discord server.
                The secret ${targetType} you have selected is: "${target.title}" (${target.year || "Unknown Year"}).
                Here is the official synopsis: "${target.summary}"

                Write 3 trivia clues to help the players guess the title. DO NOT use the title or obvious subtitle words in the clues.
                Clue 1: Extremely vague, often a funny or sarcastic oversimplification of the core plot.
                Clue 2: A bit more specific. Mention a character's first name, a setting, or a famous trope from it.
                Clue 3: Almost giving it away completely without saying the title.

                Output ONLY a raw JSON object exactly like this:
                {
                    "clue1": "The first vague clue",
                    "clue2": "The second specific clue",
                    "clue3": "The final obvious clue"
                }
                `;

                const aiResult = await model.generateContent(triviaPrompt);
                const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const clues = JSON.parse(jsonMatch[0]);

                await statusMsg.delete().catch(() => {});

                await msg.channel.send(`🚨 **VAULT TRIVIA HAS STARTED!** 🚨\nI have selected a secret **${targetType}** from The Nerdgasm server. You have 3 minutes to guess the title. Anyone can type their guess in the chat!\n\n🕐 **Clue 1:** *${clues.clue1}*`);

                const filter = m => !m.author.bot;
                const collector = msg.channel.createMessageCollector({ filter, time: 180000 });

                // Track who has successfully guessed this round
                let currentWinners = new Set();

                setTimeout(() => {
                    msg.channel.send(`🕧 **Clue 2:** *${clues.clue2}*`);
                }, 60000);

                setTimeout(() => {
                    msg.channel.send(`🕦 **Clue 3:** *${clues.clue3}*`);
                }, 120000);

                // Listen for guesses without stopping the timer
                collector.on('collect', m => {
                    // Ignore if they already guessed it correctly
                    if (currentWinners.has(m.author.id)) return;

                    const guess = cleanString(m.content);

                    if (guess === cleanTargetTitle || (guess.length > 3 && guess.includes(cleanTargetTitle))) {
                        currentWinners.add({ id: m.author.id, name: m.author.username });

                        // Delete their message so they don't spoil the answer for everyone else!
                        m.delete().catch(() => {});

                        msg.channel.send(`✅ **<@${m.author.id}> got it!** The game continues... who else knows it? 🤐`);
                    }
                });

                // End the game and tally the scores
                collector.on('end', () => {
                    if (currentWinners.size > 0) {
                        const board = loadLeaderboard();
                        let winnerNames = [];

                        currentWinners.forEach(winner => {
                            winnerNames.push(`**${winner.name}**`);

                            if (!board[winner.id]) {
                                board[winner.id] = { username: winner.name, score: 0 };
                            }
                            board[winner.id].score += 1;
                            board[winner.id].username = winner.name; // Update in case they changed their Discord name
                        });

                        saveLeaderboard(board);

                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nThe secret ${targetType.toLowerCase()} was:\n🎬 **${target.title}** (${target.year})\n\n🎉 **Points awarded to:** ${winnerNames.join(", ")}!`);
                    } else {
                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nNobody guessed it! The secret ${targetType.toLowerCase()} was:\n\n🎬 **${target.title}** (${target.year})\n> *${target.summary.substring(0, 200)}...*`);
                    }
                });

            } catch (err) {
                console.error(err);
                statusMsg.edit("❌ *My trivia notes caught on fire. Try running `!trivia` again!*").catch(() => {});
            }
        }
    }
};