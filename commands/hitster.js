const fs = require('fs');
const path = require('path');
const { getPlex } = require('../helpers/plexClient.js');
const logger = require('../helpers/logger.js');
const hitsterTurn = require('../helpers/hitsterTurn.js');
const channelClaims = require('../helpers/channelClaims.js');

const plex = getPlex();

const statsFile = path.join(__dirname, '../data/hitster_stats.json');

function loadStats() {
    if (!fs.existsSync(statsFile)) return {};
    return JSON.parse(fs.readFileSync(statsFile, 'utf8'));
}

function saveStats(data) {
    fs.writeFileSync(statsFile, JSON.stringify(data, null, 4));
}

const activeGames = new Map();

// While a game exists in a channel, raw inputs like !bonus / !localbonus are
// consumed by the turn collector, not the command dispatcher. Claim the channel
// so the dispatcher doesn't reply "unknown command" to those in-game inputs.
channelClaims.register((channelId) => activeGames.has(channelId));

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
        this.voiceChannel = null; // captured at start; .members gates proxy actions
        this.activeTurn = null;   // the in-flight turn engine, or null between turns

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
        slash: {
            description: 'Competitive turn-based music timeline game',
            subcommands: [
                { name: 'create',   description: 'Start a new Hitster lobby in this channel', options: [] },
                { name: 'join',     description: 'Join the current Hitster lobby', options: [] },
                { name: 'join-for', description: 'Add another Discord user in your voice channel to the lobby',
                  options: [{ name: 'user', type: 'USER', description: 'Someone in your voice channel who can\'t type', required: true }] },
                { name: 'add',      description: 'Add a local (in-person) player to the lobby',
                  options: [{ name: 'name', type: 'STRING', description: 'Local player name', required: true }] },
                { name: 'start',    description: 'Begin the game (host only)', options: [] },
                { name: 'stop',     description: 'End the current game (host or admin)', options: [] },
                { name: 'settings', description: 'Show the current game settings', options: [] },
                { name: 'set',      description: 'Change a setting (host only, in lobby)',
                  options: [
                    { name: 'setting', type: 'STRING', description: 'Which setting to change', required: true,
                      choices: [
                        { name: 'goal (tracks to win)', value: 'goal' },
                        { name: 'clip (seconds)',       value: 'clip' },
                        { name: 'bonus (points per steal)', value: 'bonus' }
                      ] },
                    { name: 'value', type: 'INTEGER', description: 'New value', required: true }
                  ] },
                { name: 'stats',    description: 'Show the server Hitster leaderboard', options: [] },
                { name: 'guess',    description: 'Place the current song on a slot (optionally for another player)',
                  options: [
                    { name: 'slot',  type: 'INTEGER', description: 'Slot number from the timeline', required: true },
                    { name: 'as',    type: 'USER',    description: 'Play for a Discord user in the call who can\'t type', required: false },
                    { name: 'local', type: 'STRING',  description: 'Play for a local (in-person) player by name', required: false }
                  ] },
                { name: 'bonus',    description: 'Wager points on the artist/album/title of the current song',
                  options: [
                    { name: 'type',  type: 'STRING', description: 'What to guess', required: true,
                      choices: [
                        { name: 'artist', value: 'artist' },
                        { name: 'album',  value: 'album' },
                        { name: 'title',  value: 'title' }
                      ] },
                    { name: 'guess', type: 'STRING', description: 'Your guess', required: true },
                    { name: 'as',    type: 'USER',   description: 'Wager for a Discord user in the call', required: false },
                    { name: 'local', type: 'STRING', description: 'Wager for a local (in-person) player by name', required: false }
                  ] }
            ]
        },
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

            // Slash-only in-turn actions. They read typed options off the interaction
            // and feed the same turn engine the !-text collector uses.
            if (commandArg === 'guess' || commandArg === 'bonus') {
                if (!message.interaction) {
                    return message.reply("Use `/hitster guess` or `/hitster bonus` — or type the slot number / `!bonus` during a turn.");
                }
                const game = activeGames.get(channelId);
                if (!game || !game.activeTurn) {
                    return message.reply("There's no Hitster turn in progress right now.");
                }

                const opts = message.interaction.options;
                const actorId = message.author.id;
                const asUser = opts.getUser('as');
                const sel = { userId: asUser ? asUser.id : null, localName: opts.getString('local') || null };

                if (commandArg === 'guess') {
                    const slot = opts.getInteger('slot');
                    const res = game.activeTurn.submitGuessSlash(actorId, sel, slot);
                    if (!res.ok) return message.reply(`❌ ${res.reason || 'That guess could not be placed.'}`);
                    return message.reply(res.correct
                        ? `✅ Slot ${slot} — correct! Turn resolved.`
                        : `❌ Slot ${slot} — wrong. Turn resolved.`);
                } else {
                    const type = opts.getString('type');
                    const guess = opts.getString('guess');
                    const res = game.activeTurn.submitBonusSlash(actorId, sel, type, guess);
                    if (!res.ok) return message.reply(`❌ ${res.reason || 'That bonus could not be placed.'}`);
                    return message.reply(res.correct
                        ? `✅ Bonus on **${type}** landed! ${res.dispName} +${game.settings.bonusValue}.`
                        : `❌ Bonus on **${type}** missed. ${res.dispName} -${game.settings.bonusValue}.`);
                }
            }

            if (commandArg === 'join') {
                if (!activeGames.has(channelId)) return message.reply("No active lobby. Type `!hitster` to create one.");
                const game = activeGames.get(channelId);
                if (game.state !== 'lobby') return message.reply("Game already started!");
                // Must be in the game's own voice channel, not just any channel —
                // that's where the clips play.
                if (!game.voiceChannel || !game.voiceChannel.members.has(message.author.id)) {
                    return message.reply(`Join **${game.voiceChannel ? game.voiceChannel.name : "the game's voice channel"}** first — that's where Hitster is playing.`);
                }
                game.addPlayer(message.author.id);
                return message.reply(`🎵 <@${message.author.id}> joined!`);
            }

            if (commandArg === 'join-for') {
                if (!activeGames.has(channelId)) return message.reply("No active lobby. Type `/hitster create` to make one.");
                const game = activeGames.get(channelId);
                if (game.state !== 'lobby') return message.reply("Game already started!");

                const target = message.interaction ? message.interaction.options.getUser('user') : message.mentions.users.first();
                if (!target) return message.reply("Tell me who to add — mention a user or use the `user:` option.");

                // Target must be in the game's voice channel — the one the clips play in.
                if (!game.voiceChannel || !game.voiceChannel.members.has(target.id)) {
                    return message.reply(`<@${target.id}> isn't in **${game.voiceChannel ? game.voiceChannel.name : "the game's voice channel"}** — you can only add someone who's in the call.`);
                }
                if (game.lobby.has(target.id)) return message.reply(`<@${target.id}> is already in the lobby.`);

                game.addPlayer(target.id);
                return message.channel.send(`🎵 <@${target.id}> was added to the Hitster lobby by <@${message.author.id}>!`);
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

                if (game.activeTurn && game.activeTurn.collector) game.activeTurn.collector.stop('stopped');
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

            // Explicit reply when /hitster create (or !hitster create) is used while a
            // lobby already exists — a slash interaction left without a reply hangs on
            // "thinking...", so silent fall-through isn't safe for the slash path.
            if ((commandArg === 'create' || commandArg === 'new') && activeGames.has(channelId)) {
                return message.reply("A Hitster lobby already exists in this channel. Use `join`, `start`, or `stop`.");
            }

            if (!activeGames.has(channelId)) {
                if (!message.member.voice.channel) return message.reply("Join a voice channel!");
                const game = new HitsterGame(message.author.id, channelId);
                // The host's channel IS the game's channel — join / join-for / in-turn
                // proxy all gate against its live .members. Refreshed at start in case
                // the host moves between lobby and game.
                game.voiceChannel = message.member.voice.channel;
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
                    `> • \`!hitster join-for [@user]\` - Add someone in your voice channel who can't type.\n` +
                    `> • \`!hitster add [Name]\` - Add a local player to your device (e.g., \`!hitster add Lisa\`).\n` +
                    `> • \`!hitster set [goal|clip|bonus] [number]\` - Change settings (Host only).\n` +
                    `> • \`!hitster stats\` - View the server leaderboard.\n` +
                    `> • \`!hitster start\` - Begin the game.`;

                return message.channel.send(instructions);
            }

            const game = activeGames.get(channelId);
            if (commandArg === 'start') {
                if (message.author.id !== game.hostId) return message.reply("Only the host can start the game.");
                if (game.state !== 'lobby') return message.reply("The game has already started.");
                game.state = 'playing';
                // Refresh to the host's current channel (set at lobby creation) in case
                // they moved — this is where the bot plays clips and what proxy/join gate on.
                // Guard against a null (host not in voice) clobbering the captured channel.
                if (message.member.voice.channel) game.voiceChannel = message.member.voice.channel;
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
        `*Anyone: Type \`!bonus [artist|album|title] [guess]\` to risk points!*\n` +
        `*Or use \`/hitster guess\` / \`/hitster bonus\` — add \`as:\` (a Discord user in the call) or \`local:\` (a local player) to act for someone else.*`;

    const turnMsg = await channel.send(baseMessageText);
    bot.songQueue.unshift({ key: targetObj.plexKey, title: "Secret Track", artist: "???" });
    await bot.playSong(message, targetObj.duration ? Math.floor(targetObj.duration / 2) : 60000);
    setTimeout(() => { if (bot.isPlaying) bot.stop(); }, game.settings.clipLength);

    const guessRegex = /^(\d+)$/;
    const bonusRegex = /^!bonus\s+(artist|album|title)\s+(.+)$/i;
    const localBonusRegex = /^!localbonus\s+([a-zA-Z0-9_]+)\s+(artist|album|title)\s+(.+)$/i;
    const TURN_TIMEOUT_MS = 10 * 60 * 1000;

    // Shared turn engine. The !-text collector and the /hitster guess|bonus slash
    // commands both resolve+authorize an actor, then call applyGuess/applyBonus,
    // so the two input surfaces stay in lockstep.
    const turn = {
        currentPlayerId, isLocalTurn, targetObj, correctSlot,
        turnBonuses: {}, bonusRecap: [], revealedText: '',
        guessedCorrectly: false, resolved: false,
        collector: null,
    };

    // Place a slot guess for the current player and end the turn. reactMsg is an
    // optional Discord message to ✅/❌ (text path); the slash path passes null and
    // replies from the returned result.
    turn.applyGuess = function(slot, reactMsg) {
        if (turn.resolved) return { ok: false, reason: 'The turn is already over.' };
        turn.guessedCorrectly = (parseInt(slot, 10) === correctSlot);
        if (reactMsg) reactMsg.react(turn.guessedCorrectly ? '✅' : '❌').catch(() => {});
        if (turn.collector) turn.collector.stop('guessed');
        return { ok: true, correct: turn.guessedCorrectly };
    };

    // Credit/debit a bonus wager to playerId. Mutates score + recap + the pinned
    // turn message; returns a structured result each surface presents itself.
    turn.applyBonus = function(playerId, type, guess) {
        if (turn.resolved) return { ok: false, reason: 'The turn is already over.' };
        const dispName = playerId.startsWith('local:') ? `**${game.localPlayers[playerId]}**` : `<@${playerId}>`;
        if (!turn.turnBonuses[playerId]) turn.turnBonuses[playerId] = {};
        if (turn.turnBonuses[playerId][type]) {
            return { ok: false, reason: `${dispName} already wagered on the **${type}** for this track!` };
        }
        turn.turnBonuses[playerId][type] = true;

        const correct = hitsterTurn.isBonusCorrect(targetObj, type, guess);
        if (correct) {
            game.scores[playerId] = (game.scores[playerId] || 0) + game.settings.bonusValue;
            turn.bonusRecap.push(`🟢 ${dispName}: +${game.settings.bonusValue} pt (${type})`);
            turn.revealedText += `\n> **${type.charAt(0).toUpperCase() + type.slice(1)}:** *${targetObj[type] || 'Unknown'}* (Guessed by ${dispName})`;
            turnMsg.edit(baseMessageText + `\n\n🔍 **Revealed Details:**${turn.revealedText}`).catch(e => logger.error('hitster edit failed:', e));
        } else {
            game.scores[playerId] = (game.scores[playerId] || 0) - game.settings.bonusValue;
            turn.bonusRecap.push(`🔴 ${dispName}: -${game.settings.bonusValue} pt (wrong ${type})`);
        }
        return { ok: true, correct, dispName };
    };

    // Slash entry points: resolve the on-behalf-of target and apply the VC-gated
    // proxy rule before touching the engine.
    turn.submitGuessSlash = function(actorId, sel, slot) {
        const target = hitsterTurn.resolveTarget(game, sel);
        if (target.kind === 'invalid') return { ok: false, reason: target.reason };
        const anchored = target.kind === 'self' ? { kind: 'self', id: actorId } : target;
        const targetId = target.kind === 'self' ? actorId : target.id;
        if (targetId !== currentPlayerId) {
            return { ok: false, reason: `It's ${displayPlayerName}'s turn — you can only guess for them.` };
        }
        const auth = hitsterTurn.canProxy(game, actorId, anchored);
        if (!auth.ok) return { ok: false, reason: auth.reason };
        return turn.applyGuess(slot, null);
    };

    turn.submitBonusSlash = function(actorId, sel, type, guess) {
        const target = hitsterTurn.resolveTarget(game, sel);
        if (target.kind === 'invalid') return { ok: false, reason: target.reason };
        const anchored = target.kind === 'self' ? { kind: 'self', id: actorId } : target;
        const targetId = target.kind === 'self' ? actorId : target.id;
        const auth = hitsterTurn.canProxy(game, actorId, anchored);
        if (!auth.ok) return { ok: false, reason: auth.reason };
        return turn.applyBonus(targetId, type, guess);
    };

    const gameFilter = m => {
        const text = m.content.trim();
        if (guessRegex.test(text)) {
            if (m.author.id === currentPlayerId) return true; // current player guessing for themselves
            if (isLocalTurn && game.lobby.has(m.author.id)) return true; // local turn: any lobby member proxies
        }
        if (bonusRegex.test(text) && game.lobby.has(m.author.id)) return true;
        if (localBonusRegex.test(text) && game.lobby.has(m.author.id)) return true;
        return false;
    };

    // Bound the collector so an abandoned channel can't keep the closure over
    // allTracks/game/targetObj alive forever.
    const collector = channel.createMessageCollector({ filter: gameFilter, time: TURN_TIMEOUT_MS });
    turn.collector = collector;
    game.activeTurn = turn;

    collector.on('collect', m => {
        const text = m.content.trim();
        const slotMatch = text.match(guessRegex);
        const bonusMatch = text.match(bonusRegex);
        const localBonusMatch = text.match(localBonusRegex);

        if (slotMatch) {
            turn.applyGuess(slotMatch[1], m);
        } else if (bonusMatch || localBonusMatch) {
            let playerId, type, guess;
            if (localBonusMatch) {
                playerId = `local:${localBonusMatch[1].toLowerCase()}`;
                type = localBonusMatch[2].toLowerCase();
                guess = localBonusMatch[3];
                if (!game.localPlayers[playerId]) {
                    return m.reply(`❌ Local player **${localBonusMatch[1]}** is not in this game!`);
                }
            } else {
                playerId = m.author.id;
                type = bonusMatch[1].toLowerCase();
                guess = bonusMatch[2];
            }
            const res = turn.applyBonus(playerId, type, guess);
            if (!res.ok) return m.reply(res.reason);
            m.react(res.correct ? '✅' : '❌').catch(() => {});
        }
    });

    collector.on('end', (collected, reason) => resolveTurn(reason));

    function resolveTurn(reason) {
        if (turn.resolved) return;
        turn.resolved = true;
        game.activeTurn = null;

        // Turn timed out with no guess — terminate rather than recursing into a
        // turn no one is watching.
        if (reason === 'time' || reason === 'idle') {
            channel.send(`⏳ **Hitster turn timed out** — no guess in ${TURN_TIMEOUT_MS / 60000} minutes. Game ended.`).catch(() => {});
            activeGames.delete(game.channelId);
            if (bot.isPlaying) bot.stop();
            return;
        }
        // Host/admin ended the game elsewhere; just make sure the clip is stopped.
        if (reason === 'stopped') {
            if (bot.isPlaying) bot.stop();
            return;
        }

        if (bot.isPlaying) bot.stop();
        let resultText = `🕰️ **Turn Over!** The track was:\n📅 **${targetObj.year}** - *${targetObj.title}* by ${targetObj.artist} (Album: *${targetObj.album || "Unknown"}*)\n\n`;

        const stats = loadStats();

        let uname = isLocalTurn ? `${game.localPlayers[currentPlayerId]} (Local)` : (client.users.cache.get(currentPlayerId)?.username || 'Unknown');
        if (!stats[currentPlayerId]) {
            stats[currentPlayerId] = { wins: 0, highestStreak: 0, bonusPoints: 0, username: uname };
        }

        if (turn.guessedCorrectly) {
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

        if (turn.bonusRecap.length > 0) resultText += `\n**Bonus Action Recap:**\n${turn.bonusRecap.join('\n')}\n`;

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
        setTimeout(() => {
            game.nextTurn();
            executeTurn(game, bot, message, allTracks, client).catch(err => logger.error('hitster turn failed:', err));
        }, 3000);
    }
}