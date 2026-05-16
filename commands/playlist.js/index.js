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
    process : function(bot, client, message, query) {
        if(query == "?") {
            // Replaced the spammy loop with our single, clean Embed
            const playlistHelpEmbed = new EmbedBuilder()
                .setColor('#E5A00D')
                .setTitle(`🎵 ${bot.config.serverName.toUpperCase()} PLAYLIST MANAGER 🎵`)
                .setDescription('Manage custom server playlists or play official Plex playlists!\n\n**📁 PLAYLIST MANAGEMENT**\n> `!playlist create [name]` - Create a new custom playlist.\n> `!playlist list` - See all custom playlists.\n> `!playlist print [name]` - View all songs inside a specific playlist.\n> `!playlist remove [name]` - Delete an entire custom playlist.\n\n**🎶 ADDING & REMOVING SONGS**\n> `!playlist add [playlist] [song]` - Search for a song to add to your list.\n> `!playlist choice [number]` - Select a song from the search results to add.\n> `!playlist page` - See the next page of search results.\n> `!playlist delete [playlist] [index]` - Remove a specific song (use `print` to get the index number).\n\n**▶️ PLAYBACK & PLEX INTEGRATION**\n> `!playlist play [name] [-r]` - Play your custom playlist (`-r` to shuffle).\n> `!playlist plex-list` - View all official playlists hosted on the Plex server.\n> `!playlist plex-play [name] [-r]` - Play an official Plex playlist (`-r` to shuffle).');

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