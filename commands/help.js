const { EmbedBuilder } = require('discord.js');
const config = require('../config/config.js');
const logger = require('../helpers/logger.js');

module.exports = {
    name: 'help',
    aliases: ['?'],
    command: {
        usage: '!help',
        description: `Displays the main command directory for the ${config.serverName} bot.`,
        slash: {
            description: 'Show the bot command directory'
        },
        process: async function(...args) {
            let msg = null;
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                    break;
                }
            }
            if (!msg) return logger.error('Critical Error: Could not locate the Discord message object!');

            const prefix = config.commandPrefix;

            const helpEmbed = new EmbedBuilder()
                .setColor('#2F3136')
                .setTitle(`🎮 ${config.serverName.toUpperCase()} BOT - COMMAND DIRECTORY 🎮`)
                .setDescription(
                    `Type any command by itself (e.g. \`${prefix}hitster\`) to open its specific menu.\n\n` +

                    '**🤖 AI ARCADE & MINIGAMES**\n' +
                    `> \`${prefix}hitster\` — Competitive turn-based music timeline game. Guess the year!\n` +
                    `> \`${prefix}trivia\` — Classic movie & TV show plot trivia.\n` +
                    `> \`${prefix}badplot\` — Guess the movie from a cynical AI plot summary.\n` +
                    `> \`${prefix}castingcouch\` — Guess the project from vague actor job listings.\n` +
                    `> \`${prefix}quotethebard\` — Guess the song translated into Shakespearean English.\n` +
                    `> \`${prefix}releasesurvival\` — Rapid-fire *Higher or Lower* release-year survival.\n` +
                    `> \`${prefix}rumor\` — Guess the modern movie rewritten as a D&D tavern hook.\n` +
                    `> \`${prefix}reviewbomb\` — Guess the movie from an unhinged 1-star review.\n` +
                    `> \`${prefix}survive\` — Interactive text-adventure. Can you survive the plot?\n\n` +

                    '**🎵 PLAYBACK CONTROLS**\n' +
                    `> \`${prefix}play [song/url]\` — Add a song to the queue.\n` +
                    `> \`${prefix}pause\` / \`${prefix}resume\` / \`${prefix}stop\` / \`${prefix}skip\` — Standard playback controls.\n` +
                    `> \`${prefix}seek [time]\` — Jump to a specific time in the current track *(Plex only)*.\n` +
                    `> \`${prefix}volume [1-100]\` — Adjust the bot's volume.\n` +
                    `> \`${prefix}loop\` / \`${prefix}shuffle\` — Modify how the queue plays.\n\n` +

                    '**📋 QUEUE MANAGEMENT**\n' +
                    `> \`${prefix}viewqueue\` — See what's in the current queue.\n` +
                    `> \`${prefix}clearqueue\` — Clear the queue.\n` +
                    `> \`${prefix}removesong [n]\` — Remove song N from the queue.\n` +
                    `> \`${prefix}playsong [n]\` — Play song N from the last search results.\n` +
                    `> \`${prefix}nextpage\` — Show the next page of a long search.\n\n` +

                    '**🔍 MEDIA SEARCH**\n' +
                    `> \`${prefix}song [q]\` / \`${prefix}album [q]\` / \`${prefix}artist [q]\` — Search Plex audio.\n` +
                    `> \`${prefix}youtube [url or search]\` — Play a YouTube URL, or search and play the top hit.\n` +
                    `> \`${prefix}mood [mood]\` — Random song matching a mood.\n` +
                    `> \`${prefix}random\` — Random media pick from the library.\n` +
                    `> \`${prefix}library\` — View or search server libraries.\n` +
                    `> \`${prefix}list [search|reset]\` — Browse the song library page-by-page.\n\n` +

                    '**🎵 CUSTOM PLAYLISTS**\n' +
                    `> \`${prefix}playlist\` — Manager for custom playlists (create/add/play/list/delete/print). Type \`${prefix}playlist ?\` for sub-commands.\n\n` +

                    '**🍿 AI MEDIA DISCOVERY**\n' +
                    `> \`${prefix}request\` — Anonymously request a movie/show/album for the server.\n` +
                    `> \`${prefix}curator\` — AI-tailored media recommendations with follow-up Q&A.\n` +
                    `> \`${prefix}groupwatch\` — Multiplayer curator for finding a movie a group agrees on.\n` +
                    `> \`${prefix}quest\` — Generate a custom movie marathon from a theme.\n` +
                    `> \`${prefix}identify\` — "Tip of your tongue" movie identifier from vague clues.\n` +
                    `> \`${prefix}vibe\` — Deep-scan the music library for a thematic or TTRPG playlist.\n` +
                    `> \`${prefix}sonic\` — Plex Sonic Analysis playlist around a vibe or anchor song.\n\n` +

                    '**🎲 D&D CHARACTER SHEETS**\n' +
                    `> \`${prefix}buildcharacter\` — Generate + save a Level 1 D&D character from your media habits.\n` +
                    `> \`${prefix}mysheet [@user]\` — Display your (or another user's) saved character sheet.\n` +
                    `> \`${prefix}profile\` — AI D&D character sheet driven by your gaming hours.\n\n` +

                    '**🎮 PLAYNITE / HOST PC** *(owner-gated)*\n' +
                    `> \`${prefix}game [title]\` — Search the host's game library and show metadata.\n` +
                    `> \`${prefix}launch [title]\` — Boot a game on the host PC.\n` +
                    `> \`${prefix}backlog\` — Random unplayed game from your library.\n` +
                    `> \`${prefix}pickgame [keywords]\` — AI picks the best match for keywords/hardware.\n` +
                    `> \`${prefix}stats\` — Combined Plex + Playnite + Tautulli statistics.\n\n` +

                    '**📊 ADMIN / DIAGNOSTIC**\n' +
                    `> \`${prefix}diag\` *(alias \`${prefix}plextest\`)* — Full health check across Plex, Gemini, Tautulli, Playnite.\n` +
                    `> \`${prefix}help\` *(alias \`${prefix}?\`)* — This menu.\n` +
                    `> \`${prefix}restart\` — Restart the bot process.\n\n` +

                    `> \`${prefix}ulala\` — ??? *(Try it and find out.)*`
                )
                .setFooter({ text: `Bot version visible via ${prefix}diag.` });

            try {
                await msg.channel.send({ embeds: [helpEmbed] });
            } catch (err) {
                logger.error('Failed to send help menu:', err);
            }
        }
    }
};
