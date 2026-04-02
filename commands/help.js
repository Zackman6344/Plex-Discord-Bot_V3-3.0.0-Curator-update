const { MessageEmbed } = require('discord.js');

module.exports = {
    name: 'help',
    command: {
        usage: '!help',
        description: 'Displays the main command directory for The Nerdgasm bot.',
        process: async function(...args) {
            let msg = null;

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                    break;
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            const helpEmbed = new MessageEmbed()
                .setColor('#2F3136') // Sleek dark color to match Discord's theme
                .setTitle('🎮 THE NERDGASM BOT - COMMAND DIRECTORY 🎮')
                .setDescription('Type any command by itself (e.g., `!hitster`) to open its specific menu and see how to use it!\n\n' +

                '**🤖 THE AI ARCADE & MINIGAMES**\n' +
                '> `!hitster` - A competitive turn-based music timeline game. Guess the release year!\n' +
                '> `!trivia` - Classic movie & TV show plot trivia.\n' +
                '> `!badplot` - Guess the movie from the AI\'s terrible, cynical, and sarcastic summary.\n' +
                '> `!castingcouch` - Guess the project based on vague job descriptions for the actors.\n' +
                '> `!quotethebard` - Guess the song translated into Shakespearean English.\n' +
                '> `!releasesurvival` - A rapid-fire *Higher or Lower* release year survival game.\n' +
                '> `!rumor` - Guess the modern movie rewritten as a D&D tavern quest hook.\n' +
                '> `!reviewbomb` - Guess the movie based on an unhinged, petty 1-star review.\n' +
                '> `!survive` - An interactive text-adventure. Can you survive the movie\'s plot?\n\n' +

                '**🎵 MUSIC & AUDIO CONTROLS**\n' +
                '> `!play [song/url]` - Add a song to the queue.\n' +
                '> `!pause` / `!resume` / `!stop` / `!skip` - Standard playback controls.\n' +
                '> `!volume [1-100]` - Adjust the bot\'s volume.\n' +
                '> `!loop` / `!shuffle` - Modify how the queue plays.\n' +
                '> `!viewqueue` / `!clearqueue` - Manage the current playlist.\n' +
                '> `!song` / `!album` / `!artist` / `!youtube` - Search for specific audio.\n' +
                '> `!playlist` - Access the custom playlist manager (create, add, play).\n' +
                '> `!mood [mood]` - Plays a random song matching your given mood!\n' +
                '> `!ulala` - ??? (Try it and find out).\n\n' +

                '**🎬 PLEX & MEDIA UTILITIES**\n' +
                '> `!request` - Anonymously request movies, shows, or albums for the Plex server!\n' +
                '> `!curator` - Get custom-tailored media recommendations.\n' +
                '> `!groupwatch` - A multiplayer curator to find the perfect movie for a group to watch.\n' +
                '> `!quest` - Generates a custom movie marathon based on a specific theme.\n' +
                '> `!identify` - Find that "tip of your tongue" movie from a vague description.\n' +
                '> `!vibe` - Deep-scan the music library to instantly generate a thematic or TTRPG playlist.\n' +
                '> `!library` - View or search the server\'s libraries.\n' +
                '> `!random` - Roll the dice for a random media pick.\n\n' +

                '*Page navigation commands like `!page` and `!nextpage` will appear automatically when viewing long lists.*');

            try {
                // Send the Embed to the channel
                await msg.channel.send({ embeds: [helpEmbed] });
            } catch (err) {
                console.error("Failed to send help menu:", err);
            }
        }
    }
};