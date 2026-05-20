const logger = require('../helpers/logger.js');

module.exports = {
  name : 'pause',
  command : {
    usage: '',
    description: 'pauses current song if one is playing',
    slash: {
      description: 'Pause the current song'
    },
    process: function(bot, client, message) {
      if (bot.isPlaying) {
        bot.dispatcher.pause(true); // pause song
        bot.isPaused = true;
        // Listener attachments removed: this command used to add fresh debug+error
        // listeners on every !pause invocation, which accumulated on long-running
        // songs. Error logging is already handled at the AudioPlayer's creation
        // site in app/bot.js (playSong).
        var embedObj = {
            color: 16424969,
            description: bot.language.PAUSE_INFO,
        };
        message.channel.send({ content: bot.language.PAUSE_SUCCES, embeds: [embedObj] });
      }
      else {
        message.reply(bot.language.PAUSE_FAIL);
      }
    }
  }
};