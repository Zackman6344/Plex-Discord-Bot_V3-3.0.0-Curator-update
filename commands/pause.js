const logger = require('../helpers/logger.js');
const { AudioPlayerStatus } = require('@discordjs/voice');

module.exports = {
  name : 'pause',
  command : {
    usage: '',
    description: 'pauses current song if one is playing',
    slash: {
      description: 'Pause the current song'
    },
    process: function(bot, client, message) {
      // isPlaying is set before the first player exists, and stays set while the previous track's
      // Idle player waits for the next download. pause() refuses that player and one still
      // buffering, and a flag claiming a pause that did not take makes the toggle offer Resume over
      // playing audio. An already paused player is still paused.
      const player = bot.isPlaying ? bot.dispatcher : null;
      if (player && (player.pause(true) || player.state.status === AudioPlayerStatus.Paused)) {
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