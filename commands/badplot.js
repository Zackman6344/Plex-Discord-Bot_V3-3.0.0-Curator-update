const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const fs = require('fs');
const path = require('path');
const handleAIError = require('../helpers/aiErrorHandler.js');

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

// Separate Leaderboard File Path for the Bad Plot game
const leaderboardFile = path.join(__dirname, '../config/badplot_leaderboard.json');

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
    name: 'badplot',
    command: {
        usage: '!badplot [optional: "leaderboard"]',
        description: 'Start a 3-minute game of "Explain a Plot Badly", or view the server leaderboard.',
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
                    return msg.channel.send("🍿 **Bad Plot Leaderboard** 🍿\n*It's empty! Nobody has scored any points yet. Run \`!badplot\` to start a game!*");
                }

                let boardText = "🍿 **Bad Plot Leaderboard** 🍿\n\n";
                players.slice(0, 10).forEach((p, index) => {
                    let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                    boardText += `${medal} **${p.username}**: ${p.score} pts\n`;
                });

                return msg.channel.send(boardText);
            }

            // ==========================================
            // THE BAD PLOT GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`🎲 **Bad Plot Initializing...**\n⏳ *Rummaging through the server for a random target...*`);

            try {
                const sections = await plex.query('/library/sections');
                const validSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie' || sec.type === 'show');

                if (validSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any Movie or TV Show libraries!`);
                }

                const randomSection = validSections[Math.floor(Math.random() * validSections.length)];

                await statusMsg.edit(`🎲 **Bad Plot Initializing...**\n⏳ *Targeting the ${randomSection.title} library...*`);

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
                    return statusMsg.edit(`❌ I couldn't find an item with enough metadata to ruin the plot of!`);
                }

                const targetType = target.type === 'show' ? 'TV Show' : 'Movie';
                const cleanTargetTitle = cleanString(target.title);

                await statusMsg.edit(`🎲 **Bad Plot Initializing...**\n⏳ *Target locked. The AI is writing the worst synopsis possible...*`);

                const badPlotPrompt = `
                You are playing a game of "Explain a Film/Show Plot Badly" for a Discord server.
                The secret ${targetType} you have selected is: "${target.title}" (${target.year || "Unknown Year"}).
                Here is the official synopsis: "${target.summary}"

                Write exactly 3 sentences that explain the plot of this ${targetType} as badly, hilariously, and misleadingly as possible, while remaining technically accurate.
                DO NOT use the title, obvious character names (unless heavily obscured), or obvious subtitle words.
                Sentence 1: The most vague, bizarre oversimplification.
                Sentence 2: Adds a weird detail about the setting or a character's questionable life choices.
                Sentence 3: The final punchline that makes it slightly more obvious without giving it away directly.

                Output ONLY a raw JSON object exactly like this:
                {
                    "sentence1": "First bad plot sentence.",
                    "sentence2": "Second bad plot sentence.",
                    "sentence3": "Third bad plot sentence."
                }
                `;

                const aiResult = await model.generateContent(badPlotPrompt);
                const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const clues = JSON.parse(jsonMatch[0]);

                await statusMsg.delete().catch(() => {});

                await msg.channel.send(`🚨 **EXPLAIN A PLOT BADLY HAS STARTED!** 🚨\nI have selected a secret **${targetType}** from The Nerdgasm server. You have 3 minutes to guess the title before it's revealed!\n\n🕐 **Part 1:** *${clues.sentence1}*`);

                const filter = m => !m.author.bot;
                const collector = msg.channel.createMessageCollector({ filter, time: 180000 });

                // Track who has successfully guessed this round
                let currentWinners = new Set();
                let gameWinnersData = [];

                const clue2Timer = setTimeout(() => {
                    msg.channel.send(`🕧 **Part 2:** *${clues.sentence2}*`);
                }, 60000);

                const clue3Timer = setTimeout(() => {
                    msg.channel.send(`🕦 **Part 3:** *${clues.sentence3}*`);
                }, 120000);

                // Listen for guesses without stopping the timer
                collector.on('collect', m => {
                    // Ignore if they already guessed it correctly
                    if (currentWinners.has(m.author.id)) return;

                    const guess = cleanString(m.content);

                    if (guess === cleanTargetTitle || (guess.length > 3 && guess.includes(cleanTargetTitle))) {
                        currentWinners.add(m.author.id);
                        gameWinnersData.push({ id: m.author.id, name: m.author.username });

                        // Delete their message so they don't spoil the answer for everyone else!
                        m.delete().catch(() => {});

                        msg.channel.send(`✅ **<@${m.author.id}> figured it out!** The game continues... who else knows it? 🤐`);
                    }
                });

                // End the game and tally the scores
                collector.on('end', () => {
                    if (gameWinnersData.length > 0) {
                        const board = loadLeaderboard();
                        let winnerNames = [];

                        gameWinnersData.forEach(winner => {
                            winnerNames.push(`**${winner.name}**`);

                            if (!board[winner.id]) {
                                board[winner.id] = { username: winner.name, score: 0 };
                            }
                            board[winner.id].score += 1;
                            board[winner.id].username = winner.name; // Update in case they changed their Discord name
                        });

                        saveLeaderboard(board);

                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nThe terribly-explained ${targetType.toLowerCase()} was:\n🎬 **${target.title}** (${target.year})\n\n🎉 **Points awarded to:** ${winnerNames.join(", ")}!`);
                    } else {
                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nNobody guessed it! The terribly-explained ${targetType.toLowerCase()} was:\n\n🎬 **${target.title}** (${target.year})\n> *${target.summary.substring(0, 200)}...*`);
                    }
                });

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            }
        }
    }
};