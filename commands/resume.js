module.exports = {
  name : 'resume',
  command : {
    usage: '',
    description: 'resume after pause.',
    slash: {
      description: 'Resume the paused song'
    },
    process: function(bot, client, message) {
      // Cleared whether or not unpause() takes: a refusal means the player was not paused.
      bot.isPaused = false;
      if(bot.dispatcher && bot.dispatcher.unpause()) {
        var embedObj = {
            color: 4251856,
            description: bot.language.RESUME_INFO,
        };
        message.channel.send({ content: bot.language.RESUME_SUCCES, embeds: [embedObj] });
      }
      else {
        message.reply(bot.language.RESUME_FAIL);
      }
    }
  }
};