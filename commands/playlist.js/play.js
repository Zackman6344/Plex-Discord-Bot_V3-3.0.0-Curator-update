const fs = require('fs');

//https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random
function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
};

module.exports = {
  name : 'play',
  command : {
    usage : '<playlist> -r',
    description : 'play the given playlist.\nThe \'-r\' option is to play the playlist randomly.',
    process : async function(bot, client, message, args) {
      if(args.length < 1) {
        message.reply(bot.language.ERROR_NOT_ENOUGHT_ARG);
        return ;
      }
      if(args.length > 2) {
        message.reply(bot.language.ERROR_TOO_MANY_ARGS);
        return ;
      }
      let shuffle = false;
      if(args.length == 2) {
        if(args[1] != '-r') {
          message.reply(bot.language.PLAYLIST_PLAY_R_ERROR);
          return ;
        }
        shuffle = true;
      }
      let playlistFile = bot.config.playlistsDir + args[0] + '.playlist';
      if(!fs.existsSync(playlistFile)) {
        message.reply(bot.language.PLAYLIST_UNKNOW);
      } else {
        fs.readFile(playlistFile, 'utf8', async function readFileCallback(err, data){
          if (err){
            await message.reply(bot.language.OPEN_PLAYLIST_ERROR);
            throw err;
          }
          let playlist = JSON.parse(data);
          if(shuffle){
            for(let i = 0; i < playlist.musiques.length; i++) {
              let j = getRandomInt(playlist.musiques.length);
              let inter = playlist.musiques[j];
              playlist.musiques[j] = playlist.musiques[i];
              playlist.musiques[i] = inter;
            }
          }
          // On-disk track keys (artiste/titre/cle) kept as-is for playlist file compatibility.
          playlist.musiques.forEach(function (track){
            let queued = {'artist' : track.artiste, 'title': track.titre};
            if(track.cle) {
              queued.key = track.cle;
            } else {
              queued.url = track.url;
            }
            bot.songQueue.push(queued);
          });

          if(bot.isPlaying){
            await message.reply(bot.language.PLAYLIST_PLAY_SUCCES);
            if(shuffle) {
              message.channel.send(bot.config.commandPrefix + 'viewqueue');
            }
          } else {
            if(shuffle) {
              await message.channel.send(bot.config.commandPrefix + 'viewqueue');
            }
            bot.playSong(message);
          }
      });
    }
  }
}
};
