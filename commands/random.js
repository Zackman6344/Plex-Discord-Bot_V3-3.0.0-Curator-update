const logger = require('../helpers/logger.js');

module.exports = {
  name : 'random',
  command : {
    usage: '',
    description: 'bot will join voice channel and play a random song.',
    process: async function(bot, client, message, query) {
      if (query.length == 0) {
        try {
          await bot.findRandomTracksOnPlex(message);
        } catch (err){
          logger.error('random failed:', err);
        }
      } else {
        message.reply('random don\'t take argument.');
      }
    }
  }
};