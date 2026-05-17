const logger = require('../helpers/logger.js');

var ulalaPlaying = false;

module.exports = {
  name : 'ulala',
  command : {
    usage : '',
    description : 'Ulala...',
    slash : {
      description : '???'
    },
    process : async function(bot, client, message) {
      
      if(!bot.isPlaying || ulalaPlaying){
        ulalaPlaying = !ulalaPlaying;
        let nom = "Ulala Voicemod";
        if(ulalaPlaying){
          bot.isPlaying = true;
          let track = {"url" : "https://www.youtube.com/watch?v=ElzlUMlu4G0"};
          let ulala = async function() {
            if(ulalaPlaying) {
              try {
                bot.jouerUneMusique(track, message.member.voice.channel, ulala);
              } catch (e){
                logger.error('ulala failed:', e);
                track = {"url" : "https://www.youtube.com/watch?v=ElzlUMlu4G0"};
                ulala();
              }
            }
          };
          ulala();
        } else {
          await bot.stop();
		  bot.isPlaying = false;
          if(bot.songQueue.length > 0 ) {
            bot.playSong(message);
          } else {
			await bot.playbackCompletion(message);
		  }
        }
      }
    }
  }
};