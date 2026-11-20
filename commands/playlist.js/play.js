const fs = require('fs');
const logger = require('../../helpers/logger.js');

const FLAG_LINE = 'Use `-r` to shuffle and `-e` for only the songs that still earn on your Plex Media list.';

//https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random
function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
};

function code(text) {
  return '`' + String(text).replace(/`/g, '\'') + '`';
}

function joinNames(names) {
  let named = names.map(code);
  if(named.length < 2) {
    return named.join('');
  }
  return named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1];
}

function listsOf(slots) {
  if(slots.length == 1) {
    return code(slots[0]) + '\'s list';
  }
  return 'the lists of ' + joinNames(slots);
}

function refusalLine(filter, name) {
  let slots = (filter && filter.slots) || [];
  let reason = filter && filter.reason;
  if(reason == 'none') {
    return 'No Plex Media slot is linked to you, so nothing in ' + code(name) + ' earns for you: play it without `-e` (`earning`).';
  }
  if(reason == 'unknown') {
    let who = slots.length ? joinNames(slots) : 'Your Plex Media slot';
    let verb = slots.length > 1 ? ' have not reported their items yet' : ' has not reported its items yet';
    let which = slots.length > 1 ? 'one of them' : 'it';
    return who + verb + ', so what still earns is not known: try again once ' + which + ' is connected.';
  }
  return 'Plex Media is turned off, so nothing earns: play the playlist without `-e` (`earning`).';
}

module.exports = {
  name : 'play',
  command : {
    usage : '<playlist> [-r] [-e]',
    description : 'play the given playlist.\nThe \'-r\' option is to play the playlist randomly.\nThe \'-e\' option queues only the songs that still earn on your Plex Media list.',
    process : async function(bot, client, message, args) {
      if(args.length < 1) {
        message.reply(bot.language.ERROR_NOT_ENOUGHT_ARG);
        return ;
      }
      if(args.length > 3) {
        message.reply(bot.language.ERROR_TOO_MANY_ARGS);
        return ;
      }
      let shuffle = false;
      let earning = false;
      for(const flag of args.slice(1)) {
        if(flag == '-r' && !shuffle) {
          shuffle = true;
        } else if(flag == '-e' && !earning) {
          earning = true;
        } else {
          message.reply(FLAG_LINE);
          return ;
        }
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
          // On-disk track keys (artiste/titre/cle) kept as-is for playlist file compatibility.
          let entries = playlist.musiques.map(function (track){
            // `playlist` rides along so a key repaired at play time can be written back into the
            // file it came from, rather than being re-derived on every play.
            let queued = {'artist' : track.artiste, 'title': track.titre, 'playlist': args[0]};
            if(track.cle) {
              queued.key = track.cle;
            } else {
              queued.url = track.url;
            }
            return queued;
          });
          let total = entries.length;
          let filter = null;
          if(earning) {
            filter = require('../../helpers/apMediaGame.js').earningFilter(message.author && message.author.id);
            if(!filter || !filter.ok) {
              await message.reply(refusalLine(filter, args[0]));
              return ;
            }
            entries = entries.filter(function (entry){
              return filter.earns(entry);
            });
            if(entries.length == 0) {
              await message.reply('Nothing in ' + code(args[0]) + ' still earns on ' + listsOf(filter.slots) + ', so nothing was queued.');
              return ;
            }
          }
          if(shuffle){
            for(let i = 0; i < entries.length; i++) {
              let j = getRandomInt(entries.length);
              let inter = entries[j];
              entries[j] = entries[i];
              entries[i] = inter;
            }
          }
          entries.forEach(function (queued){
            bot.songQueue.push(queued);
          });

          if(earning) {
            // A line that cannot be sent must not keep the queued songs from playing.
            try {
              await message.reply('\u25b6\ufe0f Queued ' + entries.length + ' of ' + total + ' songs from ' + code(args[0]) + ': the ones that still earn on ' + listsOf(filter.slots) + '.');
            } catch (err) {
              logger.warn('/playlist play could not send the queued line:', (err && err.message) || err);
            }
            if(!bot.isPlaying) {
              bot.playSong(message);
            }
          } else if(bot.isPlaying){
            await message.reply(bot.language.PLAYLIST_PLAY_SUCCES);
          } else {
            bot.playSong(message);
          }
      });
    }
  }
}
};
