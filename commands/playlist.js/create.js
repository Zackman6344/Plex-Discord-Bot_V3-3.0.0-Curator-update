const fs = require('fs');

module.exports = {
  name : 'create',
  command : {
    usage : '<name>',
    description : 'Create a new playlist with the given name.',
    process : async function(bot, client, message, args) {
        if(args.length < 1) {
          message.reply(bot.language.PLAYLIST_CREATE_NEED_NAME);
          return ;
        }
        if (args.length > 1) {
          message.reply(bot.language.PLAYLIST_CREATE_TOO_MANY_ARG);
          return ;
        }
        let playlistFile = bot.config.playlistsDir+args[0]+'.playlist';
		if(!fs.existsSync(bot.config.playlistsDir)) {
			fs.mkdirSync(bot.config.playlistsDir, {recursive: true});
		}
        if(fs.existsSync(playlistFile)) {
          message.reply(bot.language.PLAYLIST_CREATE_ERROR_ALREADY_EXIST);
        } else {
          let playlist = {
            nom : args[0],
            musiques : []
          };
          let json = JSON.stringify(playlist);
          fs.writeFile(playlistFile, json, 'utf8', async function (err) {
              if (err) {
                  await message.reply(bot.language.PLAYLIST_CREATE_ERROR_IO);
                  throw err;
              }
              message.reply(bot.language.PLAYLIST_CREATE_SUCCES.format({name : args[0]}));
          });
        }
		
    }
  }
};