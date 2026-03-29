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

const cleanString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '').trim();
const leaderboardFile = path.join(__dirname, '../config/bard_leaderboard.json');

function loadLeaderboard() {
    if (!fs.existsSync(leaderboardFile)) return {};
    return JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
}

function saveLeaderboard(data) {
    fs.writeFileSync(leaderboardFile, JSON.stringify(data, null, 4));
}

// Global state tracker
const activeGames = new Map();

module.exports = {
    name: 'quotethebard',
    command: {
        usage: '!quotethebard',
        description: 'Open the Main Menu for the Quote the Bard minigame.',
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

            // ==========================================
            // MAIN MENU
            // ==========================================
            if (!firstWord || firstWord === 'menu' || firstWord === 'help') {
                const menuText = `
🎭 **Quote the Bard - Main Menu** 🎭
*Welcome to the Shakespearean lyric guessing game! You have 5 Minutes and 5 Clues to decipher the verse.*

**Difficulty Tiers:**
🟢 **Easy:** Translates the most famous, recognizable chorus.
🟡 **Medium:** Translates a standard verse.
🔴 **Hard:** Translates an obscure bridge or uses extremely dense, riddle-like Shakespearean vocabulary.

**Commands:**
▶️ \`!quotethebard start [easy/medium/hard] [genre]\` - Starts a new game!
▶️ \`!quotethebard start [easy/medium/hard] playlist [Playlist Name]\` - Pulls exclusively from a specific playlist.
▶️ \`!quotethebard start [easy/medium/hard] [genre] playlist [Playlist Name]\` - Cross-references a genre within a specific playlist!
⏭️ \`!quotethebard skip\` - Ends the current round and reveals the answer.
🛑 \`!quotethebard stop\` - Cancels the current game and stops all timers.
🏆 \`!quotethebard leaderboard\` - View the server's top scorers.

*Examples:*
\`!quotethebard start hard pop punk\`
\`!quotethebard start easy playlist Guardians of the Galaxy\`
\`!quotethebard start medium acoustic playlist My Favorites\`
                `;
                return msg.channel.send(menuText.trim());
            }

            // ==========================================
            // COMMAND ROUTING
            // ==========================================
            if (firstWord === 'leaderboard' || firstWord === 'stats') {
                const board = loadLeaderboard();
                const players = Object.values(board).sort((a, b) => b.score - a.score);

                if (players.length === 0) {
                    return msg.channel.send("📜 **Quote the Bard Leaderboard** 📜\n*The scroll is empty! Run \`!quotethebard start\` to play.*");
                }

                let boardText = "📜 **Quote the Bard Leaderboard** 📜\n\n";
                players.slice(0, 10).forEach((p, index) => {
                    let medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "🏅";
                    boardText += `${medal} **${p.username}**: ${p.score} pts\n`;
                });
                return msg.channel.send(boardText);
            }

            if (firstWord === 'stop') {
                if (activeGames.has(channelId)) {
                    activeGames.get(channelId).collector.stop('force_stop');
                    activeGames.delete(channelId);
                    return msg.channel.send("🛑 **Quote the Bard** has been cancelled by the Game Master.");
                }
                return msg.channel.send("⚠️ *There is no active game in this channel to stop.*");
            }

            if (firstWord === 'skip' || firstWord === 'new') {
                if (activeGames.has(channelId)) {
                    const game = activeGames.get(channelId);
                    game.collector.stop('skip');
                    activeGames.delete(channelId);
                    return;
                } else {
                    return msg.channel.send("⚠️ *There is no active game to skip. Just type \`!quotethebard start\` to begin one!*");
                }
            }

            // ==========================================
            // STARTING A NEW GAME
            // ==========================================
            if (firstWord !== 'start') {
                return msg.channel.send("⚠️ *Unknown command. Type \`!quotethebard\` to see the Main Menu!*");
            }

            if (activeGames.has(channelId)) {
                return msg.channel.send("⚠️ *A game is already running! Use \`!quotethebard stop\` or \`!quotethebard skip\`.*");
            }

            let difficulty = "medium";
            let genre = "";
            let isPlaylist = false;
            let playlistName = "";

            const validDiffs = ['easy', 'medium', 'hard'];
            const secondWord = words[1];

            let searchTarget = "";
            if (validDiffs.includes(secondWord)) {
                difficulty = secondWord;
                searchTarget = words.slice(2).join(" ");
            } else {
                searchTarget = words.slice(1).join(" ");
            }

            if (searchTarget.includes('playlist ')) {
                isPlaylist = true;
                const parts = searchTarget.split('playlist ');
                genre = parts[0].trim();
                playlistName = parts[1].trim();
            } else {
                genre = searchTarget;
            }

            // DYNAMIC SAMPLE SIZING
            // If they want a specific genre, cast a wider net (150) so the AI can find one.
            // If completely random, choke it down to 15 to prevent popularity bias.
            let sampleSize = genre ? 150 : 15;

            // ==========================================
            // THE QUOTE THE BARD GAME
            // ==========================================
            let statusMsg = await msg.channel.send(`📜 **Summoning the Bard...**\n⏳ *Rummaging through the music vault...*`);

            try {
                let catalog = [];

                if (isPlaylist) {
                    await statusMsg.edit(`📜 **Summoning the Bard...**\n⏳ *Searching for playlist: "${playlistName}"...*`);

                    const playlistsData = await plex.query('/playlists');
                    const playlists = playlistsData.MediaContainer.Metadata || [];

                    const targetPlaylist = playlists.find(p => p.playlistType === 'audio' && p.title.toLowerCase().includes(playlistName));

                    if (!targetPlaylist) {
                        return statusMsg.edit(`❌ I couldn't find an audio playlist named "**${playlistName}**" on the server!`);
                    }

                    const playlistItems = await plex.query(`/playlists/${targetPlaylist.ratingKey}/items`);
                    const allItems = playlistItems.MediaContainer.Metadata || [];

                    if (allItems.length === 0) {
                        return statusMsg.edit(`❌ The playlist "**${targetPlaylist.title}**" is empty!`);
                    }

                    const fallbackCatalog = allItems.map(item => ({ title: item.title, artist: item.grandparentTitle || item.originalTitle || "Unknown" }));
                    catalog = fallbackCatalog.sort(() => 0.5 - Math.random()).slice(0, sampleSize);

                } else {
                    const sections = await plex.query('/library/sections');
                    const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === 'artist');

                    if (!targetSection) {
                        return statusMsg.edit(`❌ Couldn't find a music library on the server!`);
                    }

                    const libraryData = await plex.query(`/library/sections/${targetSection.key}/all?type=10`);
                    const allItems = libraryData.MediaContainer.Metadata || [];

                    if (allItems.length === 0) {
                        return statusMsg.edit(`❌ The music library is empty!`);
                    }

                    const fallbackCatalog = allItems.map(item => ({ title: item.title, artist: item.grandparentTitle || "Unknown" }));
                    catalog = fallbackCatalog.sort(() => 0.5 - Math.random()).slice(0, sampleSize);
                }

                await statusMsg.edit(`📜 **Summoning the Bard...**\n⏳ *Translating a track into Shakespearean English (Difficulty: ${difficulty.toUpperCase()})...*`);

                let aiInstructionText = "";
                let displayModeText = "";

                if (isPlaylist && genre) {
                    displayModeText = `Playlist: ${playlistName} | Filter: ${genre}`;
                    aiInstructionText = `The user wants a song from the provided catalog (which is their "${playlistName}" playlist) that ALSO fits the genre or vibe of "${genre}". Find the best match from the list.`;
                } else if (isPlaylist) {
                    displayModeText = `Playlist: ${playlistName}`;
                    aiInstructionText = `The user wants a song specifically from the provided catalog (which is their "${playlistName}" playlist). Pick any song you know well from the list.`;
                } else {
                    displayModeText = `Genre: ${genre || 'Any'}`;
                    aiInstructionText = `The user wants a song fitting the genre or vibe of "${genre || 'Any'}". Pick the best match from the catalog.`;
                }

                const bardPrompt = `
                You are a Shakespearean bard hosting a music trivia game.
                The user wants a ${difficulty} difficulty question.

                ${aiInstructionText}

                Analyze this short, strict catalog of songs from the user's Plex server:
                ${JSON.stringify(catalog)}

                Task:
                1. Select ONE song from the provided list that you know the lyrics to. You MUST pick from this specific list.
                2. Translate a section of its lyrics into formal, archaic Shakespearean English.
                    - Easy: Translate the most famous, recognizable chorus.
                    - Medium: Translate a standard verse.
                    - Hard: Translate an obscure bridge or use extremely dense, riddle-like Shakespearean vocabulary.
                3. Write 4 additional clues to help them guess the song/artist.
                    - Clue 2: A hint about the music style or tempo.
                    - Clue 3: A hint about the album, release decade, or overarching theme.
                    - Clue 4: A hint about the artist (e.g., solo act, band size, nationality).
                    - Clue 5: A massive hint or a direct synonym of the title.
                4. Provide the EXACT original lyrics you translated so they can be revealed at the end.

                Output ONLY a raw JSON object exactly like this:
                {
                    "title": "Exact Title",
                    "artist": "Exact Artist",
                    "original_lyrics": "The exact original lyrics...",
                    "lyrics": "The Shakespearean translation...",
                    "clue2": "Second clue...",
                    "clue3": "Third clue...",
                    "clue4": "Fourth clue...",
                    "clue5": "Fifth clue..."
                }
                `;

                const aiResult = await model.generateContent(bardPrompt);
                const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const aiData = JSON.parse(jsonMatch[0]);
                const cleanTargetTitle = cleanString(aiData.title);

                await statusMsg.delete().catch(() => {});

                await msg.channel.send(`🚨 **QUOTE THE BARD HAS STARTED!** 🚨\nI have selected a secret track from The Nerdgasm server. You have 5 minutes to guess the **Song Title**!\n*(Difficulty: ${difficulty.toUpperCase()} | ${displayModeText})*\n\n📜 **Clue 1 (The Verse):**\n> *"${aiData.lyrics}"*`);

                const filter = m => !m.author.bot;
                const collector = msg.channel.createMessageCollector({ filter, time: 300000 });

                activeGames.set(channelId, { collector, difficulty, genre, isPlaylist, playlistName });

                let currentWinners = new Set();
                let gameWinnersData = [];

                const clue2Timer = setTimeout(() => msg.channel.send(`🕧 **Clue 2:** *${aiData.clue2}*`), 60000);
                const clue3Timer = setTimeout(() => msg.channel.send(`🕦 **Clue 3:** *${aiData.clue3}*`), 120000);
                const clue4Timer = setTimeout(() => msg.channel.send(`🕥 **Clue 4:** *${aiData.clue4}*`), 180000);
                const clue5Timer = setTimeout(() => msg.channel.send(`🕤 **Clue 5:** *${aiData.clue5}*`), 240000);

                const timers = [clue2Timer, clue3Timer, clue4Timer, clue5Timer];

                collector.on('collect', m => {
                    if (m.content.startsWith('!')) return;
                    if (currentWinners.has(m.author.id)) return;

                    const guess = cleanString(m.content);

                    if (guess === cleanTargetTitle || (guess.length > 3 && guess.includes(cleanTargetTitle))) {
                        currentWinners.add(m.author.id);
                        gameWinnersData.push({ id: m.author.id, name: m.author.username });

                        m.delete().catch(() => {});
                        msg.channel.send(`✅ **<@${m.author.id}> hath deciphered the verse!** The song continues... who else knows it? 🤐`);
                    }
                });

                collector.on('end', (collected, reason) => {
                    timers.forEach(clearTimeout);
                    activeGames.delete(channelId);

                    if (reason === 'force_stop') return;

                    let preamble = `🕰️ **TIME'S UP!** 🕰️`;
                    if (reason === 'skip') preamble = `⏭️ **SKIPPED!**`;

                    if (gameWinnersData.length > 0) {
                        const board = loadLeaderboard();
                        let winnerNames = [];

                        gameWinnersData.forEach(winner => {
                            winnerNames.push(`**${winner.name}**`);
                            if (!board[winner.id]) board[winner.id] = { username: winner.name, score: 0 };
                            board[winner.id].score += 1;
                            board[winner.id].username = winner.name;
                        });
                        saveLeaderboard(board);

                        msg.channel.send(`${preamble}\nThe translated song was:\n🎵 **${aiData.title}** by **${aiData.artist}**\n\n📜 **Original Verse:**\n> *"${aiData.original_lyrics}"*\n\n🎉 **Points awarded to:** ${winnerNames.join(", ")}!`);
                    } else {
                        msg.channel.send(`${preamble}\nAlas, nobody guessed it! The secret song was:\n🎵 **${aiData.title}** by **${aiData.artist}**\n\n📜 **Original Verse:**\n> *"${aiData.original_lyrics}"*`);
                    }
                });

            } catch (err) {
                console.error(err);
                statusMsg.edit("❌ *The Bard dropped his lute. Try running the command again!*").catch(() => {});
            }
        }
    }
};