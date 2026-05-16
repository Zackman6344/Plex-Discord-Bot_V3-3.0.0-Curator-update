const fs = require('fs');

module.exports = {
  name : 'delete',
  command : {
    usage : '<playlist> <index>',
    description : 'remove one song from the given playlist (type !playlist print <playlist> to get the index).',
    process : async function(bot, client, message, args) {
        if(args.length < 2) {
            message.reply(bot.language.ERROR_NOT_ENOUGHT_ARG);
            return ;
        }
        if(args.length > 2) {
            message.reply(bot.language.ERROR_TOO_MANY_ARGS);
            return ;
        }
        let playlistFile = bot.config.playlistsDir + args[0] + '.playlist';
        let indice = parseInt(args[1]);
        indice = indice - 1;
        fs.readFile(playlistFile, 'utf8', async function readFileCallback(err, data){
                    if (err){
                        await message.reply(bot.language.OPEN_PLAYLIST_ERROR);
                        throw err;
                    }
                    let playlist = JSON.parse(data);
                    let removed = playlist.musiques.splice(indice, 1);
                    let json = JSON.stringify(playlist);
                    fs.writeFile(playlistFile, json, 'utf8', async function (err, written, string) {
                        if(err) {
                            await message.reply(bot.language.WRITTING_PLAYLIST_ERROR);
                            throw err;
                        }
                    });
                    
                    await message.reply(bot.language.PLAYLIST_DELETE_SUCCES.format({title: removed[0].titre, artist : removed[0].artiste, playlist_name : playlist.nom}));
            });
    }
  }
};
