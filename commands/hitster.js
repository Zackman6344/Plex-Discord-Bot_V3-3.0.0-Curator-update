const fs = require('fs');
const path = require('path');
const plexConfig = require('../config/plex.js');
const PlexAPI = require('plex-api');

const plex = new PlexAPI({
    hostname: plexConfig.hostname,
    port: plexConfig.port,
    https: plexConfig.https,
    token: plexConfig.token,
    options: plexConfig.options
});

const statsFile = path.join(__dirname, '../config/hitster_stats.json');

function loadStats() {
    if (!fs.existsSync(statsFile)) return {};
    return JSON.parse(fs.readFileSync(statsFile, 'utf8'));
}

function saveStats(data) {
    fs.writeFileSync(statsFile, JSON.stringify(data, null, 4));
}

const cleanString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '').trim();

const activeGames = new Map();

class HitsterGame {
    constructor(hostId, channelId) {
        this.hostId = hostId;
        this.channelId = channelId;
        this.lobby = new Set([hostId]);
        this.localPlayers = {}; // Maps synthetic IDs (local:name) to Display Names
        this.playerOrder = [];
        this.timelines = {};
        this.scores = {};
        this.currentStreaks = {};
        this.turnIndex = 0;

        this.settings = {
            clipLength: 12000,
            timelineGoal: 5,
            bonusValue: 1
        };

        this.state = 'lobby';
    }

    addPlayer(userId) {
        this.lobby.add(userId);
    }

    addLocalPlayer(name) {
        const localId = `local:${name.toLowerCase()}`;
        this.lobby.add(localId);
        this.localPlayers[localId] = name;
        return localId;
    }

    initializePlayers() {
        this.playerOrder = Array.from(this.lobby);
        this.playerOrder.forEach(id => {
            this.timelines[id] = [];
            this.scores[id] = 0;
            this.currentStreaks[id] = 0;
        });
    }

    getCurrentPlayer() {
        return this.playerOrder[this.turnIndex];
    }

    nextTurn() {
        this.turnIndex = (this.turnIndex + 1) % this.playerOrder.length;
    }

    getTimelineDisplay(userId) {
        const timeline = this.timelines[userId];
        if (!timeline || timeline.length === 0) return "*Timeline is empty.*";

        let display = `🔽 **[Slot 1]** *(Before ${timeline[0].year})*\n`;

        timeline.forEach((track, index) => {
            display += `📅 **${track.year}** - *${track.title}* by ${track.artist}\n`;

            if (index < timeline.length - 1) {
                let rangeText = timeline[index].year === timeline[index + 1].year
                    ? `Same year as ${timeline[index].year}`
                    : `Between ${timeline[index].year} and ${timeline[index + 1].year}`;
                display += `🔽 **[Slot ${index + 2}]** *(${rangeText})*\n`;
            }
        });

        display += `🔽 **[Slot ${timeline.length + 1}]** *(After ${timeline[timeline.length - 1].year})*`;
        return display;
    }

    getCorrectSlot(userId, targetYear) {
        const timeline = this.timelines[userId];
        for (let i = 0; i < timeline.length; i++) {
            if (targetYear <= timeline[i].year) {
                return i + 1;
            }
        }
        return timeline.length + 1;
    }
}

module.exports = {
    name: 'hitster',
    command: {
        usage: '!hitster [start|join|add|stop|set|settings|stats]',
        description: 'Play a competitive turn-based music timeline game.',
        process: async function(bot, client, message, query) {
            const channelId = message.channel.id;
            const args = query ? query.trim().split(/\s+/) : [];
            const commandArg = args[0] ? args[0].toLowerCase() : '';

            if (commandArg === 'stats' || commandArg === 'leaderboard') {
                const stats = loadStats();
                const playerIds = Object.keys(stats);

                if (playerIds.length === 0) {
                    return message.channel.send("📊 **Hitster Leaderboard:**\nNo games have been played yet! Type `!hitster` to start one.");
                }

                const sortedPlayers = playerIds.map(id => ({
                    id: id,
                    username: stats[id].username || "Unknown",
                    wins: stats[id].wins || 0,
                    bonusPoints: stats[id].bonusPoints || 0,
                    highestStreak: stats[id].highestStreak || 0
                })).sort((a, b) => {
                    if (b.wins !== a.wins) return b.wins - a.wins;
                    return b.highestStreak - a.highestStreak;
                });

                let leaderboardText = `🏆 **SERVER HITSTER LEADERBOARD** 🏆\n\n`;

                const topLimit = Math.min(10, sortedPlayers.length);
                for (let i = 0; i < topLimit; i++) {
                    const p = sortedPlayers[i];
                    let medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
                    leaderboardText += `${medal} **#${i + 1} ${p.username}** — **${p.wins}** Wins | 🔥 **${p.highestStreak}** Best Streak | **${p.bonusPoints}** Bonus Pts\n`;
                }

                const userId = message.author.id;
                const userIndex = sortedPlayers.findIndex(p => p.id === userId);

                leaderboardText += `\n`;
                if (userIndex !== -1) {
                    const u = sortedPlayers[userIndex];
                    leaderboardText += `👤 **Your Rank:** #${userIndex + 1} — **${u.wins}** Wins | 🔥 **${u.highestStreak}** Streak | **${u.bonusPoints}** Pts`;
                } else {
                    leaderboardText += `👤 **Your Rank:** Unranked`;
                }

                return message.channel.send(leaderboardText);
            }

            if (commandArg === 'join') {
                if (!activeGames.has(channelId)) return message.reply("No active lobby. Type `!hitster` to create one.");
                const game = activeGames.get(channelId);
                if (game.state !== 'lobby') return message.reply("Game already started!");
                game.addPlayer(message.author.id);
                return message.reply(`🎵 <@${message.author.id}> joined!`);
            }

            if (commandArg === 'add') {
                if (!activeGames.has(channelId)) return message.reply("No active lobby.");
                const game = activeGames.get(channelId);
                if (game.state !== 'lobby') return message.reply("Game already started!");

                const localName = args.slice(1).join(' ');
                if (!localName) return message.reply("Please provide a name. Example: `!hitster add Lisa`");

                game.addLocalPlayer(localName);
                return message.channel.send(`👤 Local player **${localName}** has joined the Hitster lobby!`);
            }

if (commandArg === 'stop') {
                if (!activeGames.has(channelId)) return message.reply("No game running.");
                const game = activeGames.get(channelId);

                // Allow the Host OR a Server Admin to stop the game
                const isHost = message.author.id === game.hostId;
                const isAdmin = message.member.permissions.has('ADMINISTRATOR');

                if (!isHost && !isAdmin) {
                    return message.reply("Only the game host or a Server Admin can stop the game.");
                }

                if (bot.isPlaying) bot.stop();
                activeGames.delete(channelId);
                return message.channel.send("🛑 Hitster terminated.");
            }

            if (commandArg === 'settings') {
                if (!activeGames.has(channelId)) return message.reply("No active game.");
                const game = activeGames.get(channelId);
                return message.channel.send(`**⚙️ Settings:** Goal: ${game.settings.timelineGoal} | Clip: ${game.settings.clipLength/1000}s | Bonus: ${game.settings.bonusValue}`);
            }

            if (commandArg === 'set') {
                if (!activeGames.has(channelId)) return message.reply("No lobby found.");
                const game = activeGames.get(channelId);
                if (message.author.id !== game.hostId || game.state !== 'lobby') return message.reply("Host only/Lobby only.");
                const setting = args[1]?.toLowerCase();
                const val = parseInt(args[2]);
                if (isNaN(val)) return message.reply("Provide a number.");
                if (setting === 'goal') game.settings.timelineGoal = val;
                else if (setting === 'clip') game.settings.clipLength = val * 1000;
                else if (setting === 'bonus') game.settings.bonusValue = val;
                return message.channel.send(`✅ Updated! Goal: ${game.settings.timelineGoal} | Clip: ${game.settings.clipLength/1000}s | Bonus: ${game.settings.bonusValue}`);
            }

            if (!activeGames.has(channelId)) {
                if (!message.member.voice.channel) return message.reply("Join a voice channel!");
                const game = new HitsterGame(message.author.id, channelId);
                activeGames.set(channelId, game);

                const instructions = `🎵 **HITSTER LOBBY INITIALIZED!** 🎵\n` +
                    `Host: <@${message.author.id}>\n\n` +
                    `**📖 How to Play:**\n` +
                    `> • Players take turns listening to a music snippet from the Plex library.\n` +
                    `> • On your turn, type the **Slot Number** (e.g., \`1\`, \`2\`) where the song's release year belongs on your timeline.\n` +
                    `> • First player to successfully place **${game.settings.timelineGoal}** tracks wins!\n\n` +
                    `**🔥 Bonus Steals (Active for all players):**\n` +
                    `> • Discord Users: \`!bonus [artist|album|title] [guess]\`\n` +
                    `> • Local Players: \`!localbonus [Name] [artist|album|title] [guess]\`\n` +
                    `> • Correct steals award **+${game.settings.bonusValue}** points. Incorrect steals subtract **-${game.settings.bonusValue}** points.\n\n` +
                    `**⚙️ Lobby Commands:**\n` +
                    `> • \`!hitster join\` - Join the game via Discord.\n` +
                    `> • \`!hitster add [Name]\` - Add a local player to your device (e.g., \`!hitster add Lisa\`).\n` +
                    `> • \`!hitster set [goal|clip|bonus] [number]\` - Change settings (Host only).\n` +
                    `> • \`!hitster stats\` - View the server leaderboard.\n` +
                    `> • \`!hitster start\` - Begin the game.`;

                return message.channel.send(instructions);
            }

            const game = activeGames.get(channelId);
            if (commandArg === 'start') {
                if (message.author.id !== game.hostId || game.state !== 'lobby') return;
                game.state = 'playing';
                game.initializePlayers();
                message.channel.send(`🎧 **Starting!** Goal: **${game.settings.timelineGoal}** Tracks.`);
                try {
                    const sections = await plex.query('/library/sections');
                    const musicSec = sections.MediaContainer.Directory.filter(s => s.type === 'artist');
                    const tracksData = await plex.query(`/library/sections/${musicSec[0].key}/all?type=10`);
                    let allTracks = tracksData.MediaContainer.Metadata.filter(t => t.year || t.parentYear);
                    game.playerOrder.forEach(p => {
                        const a = allTracks.splice(Math.floor(Math.random() * allTracks.length), 1)[0];
                        game.timelines[p].push({ year: a.year || a.parentYear, title: a.title, artist: a.grandparentTitle, album: a.parentTitle, plexKey: a.Media[0].Part[0].key });
                    });
                    executeTurn(game, bot, message, allTracks, client);
                } catch (err) {
                    message.channel.send("❌ Plex Error.");
                    activeGames.delete(channelId);
                }
            }
        }
    }
};

async function executeTurn(game, bot, message, allTracks, client) {
    const channel = message.channel;
    if (game.state !== 'playing' || allTracks.length === 0) return activeGames.delete(game.channelId);

    const currentPlayerId = game.getCurrentPlayer();
    const isLocalTurn = currentPlayerId.startsWith('local:');
    const displayPlayerName = isLocalTurn ? `**${game.localPlayers[currentPlayerId]}**` : `<@${currentPlayerId}>`;

    const target = allTracks.splice(Math.floor(Math.random() * allTracks.length), 1)[0];
    const targetObj = { year: target.year || target.parentYear, title: target.title, artist: target.grandparentTitle, album: target.parentTitle, plexKey: target.Media[0].Part[0].key, duration: target.duration };
    const correctSlot = game.getCorrectSlot(currentPlayerId, targetObj.year);

    const baseMessageText = `▶️ **It is ${displayPlayerName}'s turn!**\n\n` +
        `📜 **Current Timeline:**\n${game.getTimelineDisplay(currentPlayerId)}\n\n` +
        `🔊 **Playing your target song!** Where does this song belong?\n` +
        `*${displayPlayerName}: Type a slot number (e.g., \`1\` or \`2\`).*\n` +
        (isLocalTurn ? `*(Since ${displayPlayerName} is playing locally, anyone in the lobby can type the number for them!)*\n` : ``) +
        `*Anyone: Type \`!bonus [artist|album|title] [guess]\` to risk points!*`;

    const turnMsg = await channel.send(baseMessageText);
    bot.songQueue.unshift({ key: targetObj.plexKey, title: "Secret Track", artist: "???" });
    await bot.playSong(message, targetObj.duration ? Math.floor(targetObj.duration / 2) : 60000);
    setTimeout(() => { if (bot.isPlaying) bot.stop(); }, game.settings.clipLength);

    const guessRegex = /^(\d+)$/;
    const bonusRegex = /^!bonus\s+(artist|album|title)\s+(.+)$/i;
    const localBonusRegex = /^!localbonus\s+([a-zA-Z0-9_]+)\s+(artist|album|title)\s+(.+)$/i;

    const gameFilter = m => {
        const text = m.content.trim();

        if (guessRegex.test(text)) {
            if (m.author.id === currentPlayerId) return true; // Real player turn
            if (isLocalTurn && game.lobby.has(m.author.id)) return true; // Local turn: allow any lobby member to proxy
        }
        if (bonusRegex.test(text) && game.lobby.has(m.author.id)) return true;
        if (localBonusRegex.test(text) && game.lobby.has(m.author.id)) return true;
        return false;
    };

    const collector = channel.createMessageCollector({ filter: gameFilter });
    let guessedCorrectly = false;
    let turnBonuses = {};
    let bonusRecap = [];
    let revealedText = "";

    collector.on('collect', m => {
        const text = m.content.trim();
        const slotMatch = text.match(guessRegex);
        const bonusMatch = text.match(bonusRegex);
        const localBonusMatch = text.match(localBonusRegex);

        if (slotMatch) {
            if (parseInt(slotMatch[1]) === correctSlot) {
                guessedCorrectly = true;
                m.react('✅');
            } else {
                m.react('❌');
            }
            collector.stop();
        } else if (bonusMatch || localBonusMatch) {
            let type, guess, userId, dispName;

            if (localBonusMatch) {
                const requestedLocalName = localBonusMatch[1].toLowerCase();
                userId = `local:${requestedLocalName}`;
                type = localBonusMatch[2].toLowerCase();
                guess = localBonusMatch[3];

                if (!game.localPlayers[userId]) {
                    return m.reply(`❌ Local player **${localBonusMatch[1]}** is not in this game!`);
                }
                dispName = `**${game.localPlayers[userId]}**`;
            } else {
                type = bonusMatch[1].toLowerCase();
                guess = bonusMatch[2];
                userId = m.author.id;
                dispName = `<@${userId}>`;
            }

            if (!turnBonuses[userId]) turnBonuses[userId] = {};
            if (turnBonuses[userId][type]) return m.reply(`${dispName} already wagered on the **${type}** for this track!`);
            turnBonuses[userId][type] = true;

            let isCorrect = false;
            if (type === 'artist' && targetObj.artist && cleanString(targetObj.artist).includes(cleanString(guess))) isCorrect = true;
            if (type === 'title' && targetObj.title && cleanString(targetObj.title).includes(cleanString(guess))) isCorrect = true;
            if (type === 'album' && targetObj.album && cleanString(targetObj.album).includes(cleanString(guess))) isCorrect = true;

            if (isCorrect) {
                game.scores[userId] += game.settings.bonusValue;
                m.react('✅');
                bonusRecap.push(`🟢 ${dispName}: +${game.settings.bonusValue} pt (${type})`);
                revealedText += `\n> **${type.charAt(0).toUpperCase() + type.slice(1)}:** *${targetObj[type] || "Unknown"}* (Guessed by ${dispName})`;
                turnMsg.edit(baseMessageText + `\n\n🔍 **Revealed Details:**${revealedText}`).catch(e => console.error(e));
            } else {
                game.scores[userId] -= game.settings.bonusValue;
                m.react('❌');
                bonusRecap.push(`🔴 ${dispName}: -${game.settings.bonusValue} pt (wrong ${type})`);
            }
        }
    });

    collector.on('end', () => {
        if (bot.isPlaying) bot.stop();
        let resultText = `🕰️ **Turn Over!** The track was:\n📅 **${targetObj.year}** - *${targetObj.title}* by ${targetObj.artist} (Album: *${targetObj.album || "Unknown"}*)\n\n`;

        const stats = loadStats();

        let uname = isLocalTurn ? `${game.localPlayers[currentPlayerId]} (Local)` : (client.users.cache.get(currentPlayerId)?.username || 'Unknown');
        if (!stats[currentPlayerId]) {
            stats[currentPlayerId] = { wins: 0, highestStreak: 0, bonusPoints: 0, username: uname };
        }

        if (guessedCorrectly) {
            resultText += `🎉 **Correct!** Adding it to the timeline.\n`;
            game.timelines[currentPlayerId].push(targetObj);
            game.timelines[currentPlayerId].sort((a, b) => a.year - b.year);
            game.currentStreaks[currentPlayerId]++;

            if (game.currentStreaks[currentPlayerId] > (stats[currentPlayerId].highestStreak || 0)) {
                stats[currentPlayerId].highestStreak = game.currentStreaks[currentPlayerId];
                resultText += `🔥 **NEW RECORD!** ${displayPlayerName} reached a best streak of **${game.currentStreaks[currentPlayerId]}**!\n`;
            } else if (game.currentStreaks[currentPlayerId] > 1) {
                resultText += `🔥 *Current Streak: ${game.currentStreaks[currentPlayerId]}*\n`;
            }
        } else {
            resultText += `💀 **Incorrect!** It belonged in Slot ${correctSlot}. Timeline remains unchanged.\n`;
            game.currentStreaks[currentPlayerId] = 0;
        }

        if (bonusRecap.length > 0) resultText += `\n**Bonus Action Recap:**\n${bonusRecap.join('\n')}\n`;

        if (game.timelines[currentPlayerId].length >= game.settings.timelineGoal) {
            game.state = 'finished';

            game.playerOrder.forEach(id => {
                let pName = id.startsWith('local:') ? `${game.localPlayers[id]} (Local)` : (client.users.cache.get(id)?.username || 'Unknown');
                if (!stats[id]) stats[id] = { wins: 0, highestStreak: 0, bonusPoints: 0, username: pName };
                stats[id].bonusPoints = (stats[id].bonusPoints || 0) + game.scores[id];
            });
            stats[currentPlayerId].wins += 1;

            saveStats(stats);

            let finalScores = "\n**Final Bonus Scores:**\n";
            game.playerOrder.forEach(id => {
                let dispName = id.startsWith('local:') ? game.localPlayers[id] : `<@${id}>`;
                finalScores += `${dispName}: ${game.scores[id]} pts\n`;
            });

            channel.send(resultText + `\n🏆 **WE HAVE A WINNER!** 🏆\n${displayPlayerName} has reached ${game.settings.timelineGoal} tracks and won the game!` + finalScores);
            return activeGames.delete(game.channelId);
        }

        saveStats(stats);
        channel.send(resultText);
        setTimeout(() => { game.nextTurn(); executeTurn(game, bot, message, allTracks, client); }, 3000);
    });
}