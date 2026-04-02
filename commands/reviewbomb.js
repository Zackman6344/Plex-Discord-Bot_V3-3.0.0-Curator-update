const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const fs = require('fs');
const path = require('path');
const handleAIError = require('../helpers/aiErrorHandler.js');

const genAI = new GoogleGenerativeAI(keys.geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" });

const plex = new PlexAPI({
    hostname: plexConfig.hostname,
    port: plexConfig.port,
    https: plexConfig.https,
    token: plexConfig.token,
    options: plexConfig.options
});

// A helper function to strip punctuation for extremely forgiving answer checking
const cleanString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '').trim();

// Separate Leaderboard File Path for the Review Bomb game
const leaderboardFile = path.join(__dirname, '../config/reviewbomb_leaderboard.json');

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
    name: 'reviewbomb',
    command: {
        usage: '!reviewbomb [optional: "leaderboard"]',
        description: 'Start a 3-minute game of 1-Star Reviews, or view the server leaderboard.',
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
                    return msg.channel.send("⭐ **1-Star Review Leaderboard** ⭐\n*Nobody has left a review yet! Run \`!reviewbomb\` to start a game.*");
                }

                let boardText = "⭐ **1-Star Review Leaderboard** ⭐\n\n";
                players.slice(0, 10).forEach((p, index) => {
                    let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                    boardText += `${medal} **${p.username}**: ${p.score} pts\n`;
                });

                return msg.channel.send(boardText);
            }

            // ==========================================
            // THE REVIEW BOMB GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`⭐ **Opening Yelp...**\n⏳ *Scrolling through terrible takes on The Nerdgasm server...*`);

            try {
                const sections = await plex.query('/library/sections');
                const validSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie' || sec.type === 'show');

                if (validSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any Movie or TV Show libraries to pull reviews from!`);
                }

                const randomSection = validSections[Math.floor(Math.random() * validSections.length)];

                await statusMsg.edit(`⭐ **Opening Yelp...**\n⏳ *Targeting the ${randomSection.title} library...*`);

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
                    return statusMsg.edit(`❌ I couldn't find an item with enough metadata to review!`);
                }

                const targetType = target.type === 'show' ? 'TV Show' : 'Movie';
                const cleanTargetTitle = cleanString(target.title);

                await statusMsg.edit(`⭐ **Opening Yelp...**\n⏳ *Target locked. The AI is writing the most petty 1-star review possible...*`);

                const reviewPrompt = `
                You are a petty, furious, and utterly unhinged internet reviewer writing a 1-star review for a ${targetType}.
                You completely missed the point of the plot and are complaining about trivial, absurd, or bizarre things that technically happened in the story.

                The secret ${targetType} you are reviewing is: "${target.title}" (${target.year || "Unknown Year"}).
                Here is the official synopsis for context: "${target.summary}"

                Write exactly 3 clues to help the players guess the real title. DO NOT use the actual title, obvious character names, or obvious subtitle words.

                Clue 1: A vague, petty complaint about the inciting incident or the main character's initial life choices.
                Clue 2: A highly specific, ridiculous grievance about a major plot point, setting, or a supporting character's behavior.
                Clue 3: The final, furious concluding sentence of the review that makes the movie slightly more obvious without saying the title. End it with "1/5 stars" or something similar.

                Output ONLY a raw JSON object exactly like this:
                {
                    "clue1": "First petty complaint.",
                    "clue2": "Second ridiculous grievance.",
                    "clue3": "Furious conclusion. 1 star."
                }
                `;

                const aiResult = await model.generateContent(reviewPrompt);
                const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const clues = JSON.parse(jsonMatch[0]);

                await statusMsg.delete().catch(() => {});

                await msg.channel.send(`🚨 **THE REVIEW BOMB HAS DROPPED!** 🚨\nSome angry internet troll just left a 1-star review for a **${targetType}** on the server. You have 3 minutes to figure out what they watched!\n\n😡 **Part 1:** *"${clues.clue1}"*`);

                const filter = m => !m.author.bot && !m.content.startsWith('!');
                const collector = msg.channel.createMessageCollector({ filter, time: 180000 });

                let currentWinners = new Set();
                let gameWinnersData = [];

                const clue2Timer = setTimeout(() => {
                    msg.channel.send(`🤬 **Part 2:** *"${clues.clue2}"*`);
                }, 60000);

                const clue3Timer = setTimeout(() => {
                    msg.channel.send(`😤 **Part 3:** *"${clues.clue3}"*`);
                }, 120000);

                // Listen for guesses without stopping the timer
                collector.on('collect', m => {
                    if (currentWinners.has(m.author.id)) return;

                    const guess = cleanString(m.content);

                    if (guess === cleanTargetTitle || (guess.length > 3 && guess.includes(cleanTargetTitle))) {
                        currentWinners.add(m.author.id);
                        gameWinnersData.push({ id: m.author.id, name: m.author.username });

                        // Delete their message so they don't spoil the answer for everyone else
                        m.delete().catch(() => {});

                        msg.channel.send(`✅ **<@${m.author.id}> figured out what the troll was watching!** The review continues... who else knows it? 🤐`);
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
                            board[winner.id].username = winner.name;
                        });

                        saveLeaderboard(board);

                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nThe review was utterly ridiculous, but it was actually about:\n🎬 **${target.title}** (${target.year})\n\n🎉 **Points awarded to:** ${winnerNames.join(", ")}!`);
                    } else {
                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nNobody could decipher the troll's rambling! The review was actually about:\n\n🎬 **${target.title}** (${target.year})\n> *${target.summary.substring(0, 200)}...*`);
                    }
                });

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            }
        }
    }
};