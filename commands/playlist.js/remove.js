const fs = require('fs');

module.exports = {
  name : 'remove',
  command : {
    usage : '<playlist>',
    description : 'remove the given playlist.',
    process : async function(bot, client, message, args) {
        if(args.length < 1) {
            message.reply(bot.language.ERROR_NOT_ENOUGHT_ARG);
            return ;
        }
        if(args.length > 1) {
            message.reply(bot.language.ERROR_TOO_MANY_ARGS);
            return ;
        }
        var playlistFile = bot.config.playlistsDir + args[0] + '.playlist';
        if(!fs.existsSync(playlistFile)) {
            message.reply(bot.language.PLAYLIST_UNKNOW);
            return
        }
        fs.unlink(playlistFile, (err) => {
            if (err){
                message.reply(bot.language.PLAYLIST_REMOVE_ERROR);
                throw err;
            }
            bot.botPlaylist = null;
            message.reply(bot.language.PLAYLIST_REMOVE_SUCCES.format({name : args[0]}));
        });
    }
 }
};