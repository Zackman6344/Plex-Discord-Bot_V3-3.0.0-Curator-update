const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const longForm = require('../../helpers/longForm.js');

module.exports = {
  name : 'add',
  command : {
    usage : '<playlist> <music name>',
    description : 'Add a music to the given playlist.',
    process : async function(bot, client, message, args) {
        if(args.length < 2) {
            message.reply(bot.language.ERROR_NOT_ENOUGHT_ARG);
            return ;
        }
        let query = args[1];
        args.slice(2).forEach(function(iter){
            query = query + ' ' + iter;
        });

        let playlistFile = bot.config.playlistsDir + args[0] + '.playlist';
        if(!fs.existsSync(playlistFile)) {
            message.reply(bot.language.PLAYLIST_UNKNOW);
        } else {
          if(ytdl.validateURL(query)) {
            ytdl.getInfo(query).then(function(songInfo) {
              // On-disk track keys (artiste/titre/cle) kept in original form for playlist file compatibility.
              let track = {
                query : query,
                artiste : songInfo.videoDetails.author.name,
                titre : songInfo.videoDetails.title,
                url : songInfo.videoDetails.video_url,
              };
              bot.addToPlaylist(args[0], track, message);
            });
          } else {
            bot.findTracksOnPlex(query, 0, 10).then(async function(res) {
              // `choice` indexes bot.tracks by the numbers shown, so only music hits are kept.
              const { music: liste, books } = longForm.partition(res.MediaContainer.Metadata);
              let taille = liste.length;
              // A full raw page may hide songs on the next one, so a lone song among chapters is
              // offered for choice rather than written straight into the playlist.
              const morePages = books.length > 0 && res.MediaContainer.size >= 10;
              if (taille < 1 && books.length) {
                  if (!morePages) {
                      await message.reply(longForm.onlyBooksLine(books));
                      return;
                  }
                  bot.tracks = liste;
                  bot.plexQuery = query;
                  bot.plexOffset = res.MediaContainer.size;
                  bot.botPlaylist = args[0];
                  await message.reply(`${longForm.onlyBooksLine(books)}\n**${bot.config.commandPrefix}playlist page** if the music you want is not in this page.`);
                  return;
              }
              if (taille < 1) {
                  await message.reply(bot.language.BOT_FIND_SONG_ERROR);
                  throw "La musique n'a pas été trouvée.";
              }
              const bookLine = books.length ? longForm.redirectLine(longForm.worksFor(books)) : '';
              if (taille > 1 || morePages) {
                  let messageLines = '\n';
                  bot.tracks = liste;
                  bot.plexQuery = query; // set query for !nextpage
                  bot.plexOffset = res.MediaContainer.size; // set paging
                  bot.botPlaylist = args[0];
                  let artist;
                  for (let t = 0; t < bot.tracks.length; t++) {
                      if ('originalTitle' in bot.tracks[t]) {
                          artist = bot.tracks[t].originalTitle;
                      }
                      else {
                          artist = bot.tracks[t].grandparentTitle;
                      }
                      messageLines += bot.language.BOT_FIND_SONG_INFO_MUSIC.format({index : t+1, artist : artist, title : bot.tracks[t].title}) + '\n';
                  }
                  if (bookLine) messageLines += bookLine + '\n';
                  messageLines += bot.language.PLAYLIST_ADD_INFO.format({commandPrefix : bot.config.commandPrefix});
                  message.reply(messageLines);
                  return ;
              }
              if (bookLine) message.reply(bookLine);

              let key = liste[0].Media[0].Part[0].key;
              let artist = '';
              let title = liste[0].title;
              if ('originalTitle' in liste[0]) {
                artist = liste[0].originalTitle;
              }
              else {
                artist = liste[0].grandparentTitle;
              }
              let track = {
                  query : query,
                  artiste : artist,
                  titre : title,
                  cle : key
              };
              bot.addToPlaylist(args[0], track, message);
            });
          }
      }
    }
  }
};
