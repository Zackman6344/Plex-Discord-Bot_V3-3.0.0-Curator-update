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

// Forgiving answer checking
const cleanString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '').trim();

// Separate Leaderboard File Path for Casting Couch
const leaderboardFile = path.join(__dirname, '../config/castingcouch_leaderboard.json');

// Helper to load the leaderboard
function loadLeaderboard() {
    if (!fs.existsSync(leaderboardFile)) return {};
    return JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
}

// Helper to save the leaderboard
function saveLeaderboard(data) {
    fs.writeFileSync(leaderboardFile, JSON.stringify(data, null, 4));
}

module.exports = {
    name: 'castingcouch',
    command: {
        usage: '!castingcouch [optional: "leaderboard"]',
        description: 'Start a 3-minute game of Casting Couch, or view the server leaderboard.',
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
                    return msg.channel.send("🎬 **Casting Couch Leaderboard** 🎬\n*It's empty! Nobody has scored any points yet. Run \`!castingcouch\` to start a game!*");
                }

                let boardText = "🎬 **Casting Couch Leaderboard** 🎬\n\n";
                players.slice(0, 10).forEach((p, index) => {
                    let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                    boardText += `${medal} **${p.username}**: ${p.score} pts\n`;
                });

                return msg.channel.send(boardText);
            }

            // ==========================================
            // THE CASTING COUCH GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`🎲 **Casting Couch Initializing...**\n⏳ *Reviewing headshots in the Plex server...*`);

            try {
                const sections = await plex.query('/library/sections');
                const validSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie' || sec.type === 'show');

                if (validSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any Movie or TV Show libraries!`);
                }

                const randomSection = validSections[Math.floor(Math.random() * validSections.length)];

                await statusMsg.edit(`🎲 **Casting Couch Initializing...**\n⏳ *Targeting the ${randomSection.title} library...*`);

                // We use Plex's /all endpoint which usually includes a limited Role array
                const libraryData = await plex.query(`/library/sections/${randomSection.key}/all`);
                const allItems = libraryData.MediaContainer.Metadata || [];

                if (allItems.length === 0) {
                    return statusMsg.edit(`❌ The ${randomSection.title} library is empty!`);
                }

                // We must find a movie/show that actually has cast metadata attached to it
                let target = null;
                let attempts = 0;
                while (!target && attempts < 100) {
                    let randomItem = allItems[Math.floor(Math.random() * allItems.length)];
                    if (randomItem.summary && randomItem.title && randomItem.Role && randomItem.Role.length >= 3) {
                        target = randomItem;
                    }
                    attempts++;
                }

                if (!target) {
                    return statusMsg.edit(`❌ I couldn't find an item with enough cast metadata to build a game! Try scanning your Plex library metadata.`);
                }

                const targetType = target.type === 'show' ? 'TV Show' : 'Movie';
                const cleanTargetTitle = cleanString(target.title);

                // Format the cast list so the AI knows who plays who
                const castList = target.Role.slice(0, 5).map(r => `${r.tag} (who plays: ${r.role || 'Unknown Character'})`).join(", ");

                await statusMsg.edit(`🎲 **Casting Couch Initializing...**\n⏳ *Target locked. The AI Casting Director is writing the job descriptions...*`);

                const castingPrompt = `
                You are playing a game called "Casting Couch" for a Discord server.
                The secret ${targetType} you have selected is: "${target.title}" (${target.year || "Unknown Year"}).
                Here is the cast list for this ${targetType}: ${castList}
                Here is the synopsis for context: "${target.summary}"

                Write exactly 3 clues. For each clue, explicitly NAME one of the actors from the cast list provided, and write a vague, slightly sarcastic, or funny description of their character's role in the plot.
                DO NOT name the character directly if it gives away the movie too easily, and DO NOT use the movie/show title.
                Clue 1: Name an actor (preferably a supporting one) and vaguely describe what they do.
                Clue 2: Name another actor and vaguely describe their role.
                Clue 3: Name the lead/most famous actor from the list and vaguely describe their role.

                Finally, create a "reveal" section that explicitly states which actor played which character for the three actors you chose, formatted nicely.

                Output ONLY a raw JSON object exactly like this:
                {
                    "clue1": "**[Actor Name]** plays a [vague description of their role/actions].",
                    "clue2": "**[Actor Name]** plays a [vague description of their role/actions].",
                    "clue3": "**[Actor Name]** plays a [vague description of their role/actions].",
                    "reveal": "> **Actor 1** played [Character]\n> **Actor 2** played [Character]\n> **Actor 3** played [Character]"
                }
                `;

                const aiResult = await model.generateContent(castingPrompt);
                const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const clues = JSON.parse(jsonMatch[0]);

                await statusMsg.delete().catch(() => {});

                await msg.channel.send(`🚨 **THE CASTING COUCH HAS OPENED!** 🚨\nI have selected a secret **${targetType}** from The Nerdgasm server. You have 3 minutes to figure out what project connects these actors!\n\n🕐 **Actor 1:** ${clues.clue1}`);

                const filter = m => !m.author.bot;
                const collector = msg.channel.createMessageCollector({ filter, time: 180000 });

                let currentWinners = new Set();
                let gameWinnersData = [];

                const clue2Timer = setTimeout(() => {
                    msg.channel.send(`🕧 **Actor 2:** ${clues.clue2}`);
                }, 60000);

                const clue3Timer = setTimeout(() => {
                    msg.channel.send(`🕦 **Actor 3:** ${clues.clue3}`);
                }, 120000);

                // Listen for guesses
                collector.on('collect', m => {
                    if (currentWinners.has(m.author.id)) return;

                    const guess = cleanString(m.content);

                    if (guess === cleanTargetTitle || (guess.length > 3 && guess.includes(cleanTargetTitle))) {
                        currentWinners.add(m.author.id);
                        gameWinnersData.push({ id: m.author.id, name: m.author.username });

                        m.delete().catch(() => {});

                        msg.channel.send(`✅ **<@${m.author.id}> cracked the casting code!** The game continues... who else knows it? 🤐`);
                    }
                });

                // End the game
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

                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nThe secret ${targetType.toLowerCase()} was:\n🎬 **${target.title}** (${target.year})\n\n🎭 **The Roles:**\n${clues.reveal}\n\n🎉 **Points awarded to:** ${winnerNames.join(", ")}!`);
                    } else {
                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nNobody guessed it! The secret ${targetType.toLowerCase()} was:\n\n🎬 **${target.title}** (${target.year})\n\n🎭 **The Roles:**\n${clues.reveal}\n\n> *${target.summary.substring(0, 200)}...*`);
                    }
                });

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            }
        }
    }
};