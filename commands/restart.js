const logger = require('../helpers/logger.js');

module.exports = {
  name : 'restart',
  command : {
    usage: '',
    description: 'restart the plex bot.',
    process: function(bot, client, message) {
        const { start, stop } = require('../app/utils.js');
        stop(bot, client);
        logger.info('Bot restarting...');
        start();
    }
  }
};