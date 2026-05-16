module.exports = function(client, bot) {
  // plex commands -------------------------------------------------------------
  const plexCommands = require('../commands');
  const logger = require('../helpers/logger.js');
  const { startHealthMonitor } = require('../helpers/healthMonitor.js');
  // when bot is ready
  client.once('clientReady', function() {
    logger.info(`Bot ready — logged in as ${client.user.tag}`);
    startHealthMonitor(client);
  });

  // when message is sent to discord
  client.on('messageCreate', function(message){

      var msg = message.content;

      if (msg.startsWith(bot.config.commandPrefix)){
        if(bot.config.listenChannel == '' || message.channel.name == bot.config.listenChannel) {
            var cmdTxt = msg.split(/\s+/)[0].substring(bot.config.commandPrefix.length, msg.length).toLowerCase();
            var query = msg.substring(cmdTxt.length + bot.config.commandPrefix.length + 1);

            // !? is registered as an alias of !help via commands/index.js's alias mechanism,
            // so the normal dispatch below picks it up.
            var cmd = plexCommands[cmdTxt];

            if (cmd){
              try {
                cmd.process(bot, client, message, query);
              }
              catch (e) {
                logger.error(`Command "${cmdTxt}" threw:`, e);
              }
            }
            else {
              message.reply(bot.language.MUSIC_UNKNOW_COMMAND.format({cmdTxt : cmdTxt}));
            }
        }
      }

  });
};
