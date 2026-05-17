const { EmbedBuilder } = require('discord.js');

var playlistSubcommands = {};

require('fs').readdirSync(__dirname + '/').forEach(function(file) {
  if (file.match(/\.js$/) && file !== 'index.js') {
    let command = require(__dirname + '/' +file.replace('.js', ''));
    playlistSubcommands[command.name] = command.command;
  }
});

module.exports = {
  name : 'playlist',
  command : {
    usage : '<command>',
    description : 'Manipulate playlists. Type "!playlist ?" to get more help.',
    slash : {
      description: 'Manage custom playlists and Plex playlists',
      subcommands: [
        { name: 'create',    description: 'Create a new empty custom playlist',
          options: [{ name: 'name', type: 'STRING', description: 'Playlist name', required: true }] },
        { name: 'list',      description: 'List all custom playlists', options: [] },
        { name: 'print',     description: 'Show the songs inside a custom playlist',
          options: [{ name: 'name', type: 'STRING', description: 'Playlist name', required: true }] },
        { name: 'remove',    description: 'Delete a custom playlist',
          options: [{ name: 'name', type: 'STRING', description: 'Playlist name', required: true }] },
        { name: 'add',       description: 'Add a song to a custom playlist',
          options: [
            { name: 'playlist', type: 'STRING', description: 'Custom playlist name', required: true },
            { name: 'song',     type: 'STRING', description: 'Song title or YouTube URL', required: true }
          ] },
        { name: 'choice',    description: 'Pick a song from the last search results to add',
          options: [{ name: 'number', type: 'INTEGER', description: 'Search result number', required: true }] },
        { name: 'page',      description: 'Show the next page of search results', options: [] },
        { name: 'delete',    description: 'Remove a song from a playlist by index',
          options: [
            { name: 'playlist', type: 'STRING',  description: 'Playlist name', required: true },
            { name: 'index',    type: 'INTEGER', description: 'Song index (see /playlist print)', required: true }
          ] },
        { name: 'play',      description: 'Play a custom playlist (joins your voice channel)',
          options: [{ name: 'name', type: 'STRING', description: 'Custom playlist name', required: true }] },
        { name: 'plex-list', description: 'List Plex audio playlists (optionally for a managed user)',
          options: [{ name: 'account', type: 'STRING', description: 'Managed user (prompts for PIN via DM)', required: false }] },
        { name: 'plex-play', description: 'Play a Plex-hosted playlist',
          options: [{ name: 'name', type: 'STRING', description: 'Plex playlist name', required: true }] },
        { name: 'plex-copy', description: 'Interactive wizard: copy a managed user\'s Plex playlist into a local bot playlist', options: [] }
      ]
    },
    process : function(bot, client, message, query) {
        if(query == "?") {
            // Replaced the spammy loop with our single, clean Embed
            const playlistHelpEmbed = new EmbedBuilder()
                .setColor('#E5A00D')
                .setTitle(`🎵 ${bot.config.serverName.toUpperCase()} PLAYLIST MANAGER 🎵`)
                .setDescription(
                    `Manage custom server playlists or pull from Plex!\n\n` +
                    `**📁 PLAYLIST MANAGEMENT**\n` +
                    `> \`${bot.config.commandPrefix}playlist create [name]\` — Create a new custom playlist.\n` +
                    `> \`${bot.config.commandPrefix}playlist list\` — See all custom playlists.\n` +
                    `> \`${bot.config.commandPrefix}playlist print [name]\` — View all songs inside a specific playlist.\n` +
                    `> \`${bot.config.commandPrefix}playlist remove [name]\` — Delete an entire custom playlist.\n\n` +
                    `**🎶 ADDING & REMOVING SONGS**\n` +
                    `> \`${bot.config.commandPrefix}playlist add [playlist] [song]\` — Search for a song to add to your list.\n` +
                    `> \`${bot.config.commandPrefix}playlist choice [number]\` — Select a song from the search results to add.\n` +
                    `> \`${bot.config.commandPrefix}playlist page\` — See the next page of search results.\n` +
                    `> \`${bot.config.commandPrefix}playlist delete [playlist] [index]\` — Remove a specific song (use \`print\` to get the index number).\n\n` +
                    `**▶️ PLAYBACK & PLEX INTEGRATION**\n` +
                    `> \`${bot.config.commandPrefix}playlist play [name] [-r]\` — Play your custom playlist (\`-r\` to shuffle).\n` +
                    `> \`${bot.config.commandPrefix}playlist plex-list [managed-user]\` — View Plex playlists. Optional managed-user shows that account's lists (DM-prompted PIN).\n` +
                    `> \`${bot.config.commandPrefix}playlist plex-play [name] [-r]\` — Play an official Plex playlist (\`-r\` to shuffle).\n` +
                    `> \`${bot.config.commandPrefix}playlist plex-copy\` — Interactive wizard: copy any managed-user's Plex playlist into a local bot playlist (asks for PIN via DM). Once copied, anyone can use it with \`play\`.`
                );

            message.channel.send({ embeds: [playlistHelpEmbed] });
            return;
        }

        const args = query.split(/\s+/);
        const sub = playlistSubcommands[args[0]];
        if (sub) {
            sub.process(bot, client, message, args.slice(1));
        } else {
            message.reply(bot.language.PLAYLIST_UNKNOW_COMMAND.format({command : args[0], commandPrefix : bot.config.commandPrefix}));
        }
        
    }
  },
}