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

// Separate Leaderboard File Path for the Tavern Rumor game
const leaderboardFile = path.join(__dirname, '../config/rumor_leaderboard.json');

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
    name: 'rumor',
    command: {
        usage: '!rumor [optional: "leaderboard"]',
        description: 'Start a 3-minute game of Tavern Rumors, or view the server leaderboard.',
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
                    return msg.channel.send("🍻 **Tavern Rumor Leaderboard** 🍻\n*The tavern is empty! Nobody has scored any points yet. Run \`!rumor\` to start a game!*");
                }

                let boardText = "🍻 **Tavern Rumor Leaderboard** 🍻\n\n";
                players.slice(0, 10).forEach((p, index) => {
                    let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                    boardText += `${medal} **${p.username}**: ${p.score} pts\n`;
                });

                return msg.channel.send(boardText);
            }

            // ==========================================
            // THE TAVERN RUMOR GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`🍻 **Pulling up a chair...**\n⏳ *Eavesdropping on the patrons in The Nerdgasm server...*`);

            try {
                const sections = await plex.query('/library/sections');
                const validSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie' || sec.type === 'show');

                if (validSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any Movie or TV Show libraries to pull rumors from!`);
                }

                const randomSection = validSections[Math.floor(Math.random() * validSections.length)];

                await statusMsg.edit(`🍻 **Pulling up a chair...**\n⏳ *Listening closely to the ${randomSection.title} patrons...*`);

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
                    return statusMsg.edit(`❌ I couldn't find an item with enough metadata to turn into a rumor!`);
                }

                const targetType = target.type === 'show' ? 'TV Show' : 'Movie';
                const cleanTargetTitle = cleanString(target.title);

                await statusMsg.edit(`🍻 **Pulling up a chair...**\n⏳ *Target locked. The Game Master is writing the quest hook...*`);

                const rumorPrompt = `
                You are a shady, gossiping NPC sitting in a dimly lit fantasy tavern, offering a quest hook to a group of adventurers.
                The secret ${targetType} you are whispering about is: "${target.title}" (${target.year || "Unknown Year"}).
                Here is the official synopsis: "${target.summary}"

                Rewrite the entire plot of this ${targetType} as if it were a high fantasy D&D quest hook or tavern rumor.
                CRITICAL RULE: Translate all modern or sci-fi concepts into fantasy equivalents (e.g., hackers become wizards, spaceships become astral galleons, guns become wands or crossbows, corporations become merchant guilds).
                DO NOT use the actual title, obvious character names, or obvious subtitle words.

                Write exactly 3 clues to help the players guess the real title.
                Clue 1: A vague, whispered rumor about the inciting incident.
                Clue 2: A bit more specific. Mention the setting, the villain, or the "adventurers" involved.
                Clue 3: The final punchline that reveals the twist or the climax of the story, making it slightly more obvious.

                Output ONLY a raw JSON object exactly like this:
                {
                    "clue1": "First whispered rumor.",
                    "clue2": "Second detailed rumor.",
                    "clue3": "Third obvious rumor."
                }
                `;

                const aiResult = await model.generateContent(rumorPrompt);
                const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const clues = JSON.parse(jsonMatch[0]);

                await statusMsg.delete().catch(() => {});

                await msg.channel.send(`🍻 **THE TAVERN RUMOR HAS STARTED!** 🍻\nA cloaked stranger buys you an ale and leans in to whisper a secret... guess the real **${targetType}** they are talking about! You have 3 minutes.\n\n🕐 **Rumor 1:** *"${clues.clue1}"*`);

                const filter = m => !m.author.bot;
                const collector = msg.channel.createMessageCollector({ filter, time: 180000 });

                let currentWinners = new Set();
                let gameWinnersData = [];

                const clue2Timer = setTimeout(() => {
                    msg.channel.send(`🕧 **Rumor 2:** *"${clues.clue2}"*`);
                }, 60000);

                const clue3Timer = setTimeout(() => {
                    msg.channel.send(`🕦 **Rumor 3:** *"${clues.clue3}"*`);
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

                        msg.channel.send(`✅ **<@${m.author.id}> sees through the disguise!** The stranger keeps talking... who else knows the tale? 🤐`);
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

                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nThe stranger vanishes into the shadows. The tale they were telling was actually:\n🎬 **${target.title}** (${target.year})\n\n🎉 **Gold pieces awarded to:** ${winnerNames.join(", ")}!`);
                    } else {
                        msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nThe stranger shakes his head at your ignorance and leaves. The tale was actually:\n\n🎬 **${target.title}** (${target.year})\n> *${target.summary.substring(0, 200)}...*`);
                    }
                });

            } catch (err) {
                console.error(err);
                statusMsg.edit("❌ *The tavern guard threw me out. Try running \`!rumor\` again!*").catch(() => {});
            }
        }
    }
};