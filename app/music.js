module.exports = function(client, bot) {
  // plex commands -------------------------------------------------------------
  const plexCommands = require('../commands');
  const logger = require('../helpers/logger.js');
  const { startHealthMonitor } = require('../helpers/healthMonitor.js');
  const slashRegistry = require('../helpers/slashRegistry.js');
  const { adaptInteraction } = require('../helpers/interactionAdapter.js');
  const playbackButtons = require('../helpers/playbackButtons.js');
  const channelClaims = require('../helpers/channelClaims.js');

  // when bot is ready
  client.once('clientReady', async function() {
    logger.info(`Bot ready — logged in as ${client.user.tag}`);
    startHealthMonitor(client);
    // Slash command registration: commands declaring a `slash` block in commands/index.js
    // get registered with Discord on each boot. Fast in test-guild mode, slow globally.
    try {
      await slashRegistry.registerAll(client, plexCommands);
    } catch (err) {
      logger.error('Slash command registration failed:', err.message || err);
    }
  });

  // PREFIX path — original !-prefix command dispatcher, unchanged behavior.
  client.on('messageCreate', function(message){
      // Ignore messages from bots (including this bot itself). Removes the risk
      // that prefix-style text the bot ever emits re-triggers the dispatcher.
      if (message.author && message.author.bot) return;

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
              // Stay quiet if an interactive feature (e.g. a Hitster game) owns
              // raw input in this channel — !bonus and friends aren't registered
              // commands but are valid in-game, so "unknown command" would be noise.
              if (channelClaims.isClaimed(message.channel.id)) return;
              message.reply(bot.language.MUSIC_UNKNOW_COMMAND.format({cmdTxt : cmdTxt}));
            }
        }
      }

  });

  // SLASH path — wraps the interaction in a Message-shaped facade and dispatches
  // through the same plexCommands map. Commands that declare a `.slash` block
  // are reachable via `/name`; ones without it remain prefix-only.
  client.on('interactionCreate', async function(interaction){
    // Autocomplete is its own interaction type. Respond empty when no handler
    // is declared so Discord stops the loading spinner instead of timing out.
    if (interaction.isAutocomplete && interaction.isAutocomplete()) {
      const acCmd = plexCommands[interaction.commandName];
      const handler = acCmd && acCmd.slash && acCmd.slash.autocomplete;
      if (typeof handler !== 'function') {
        try { await interaction.respond([]); } catch (_) {}
        return;
      }
      try {
        await handler(interaction, bot, client);
      } catch (err) {
        logger.error(`Autocomplete for /${interaction.commandName} threw:`, err.message || err);
        try { await interaction.respond([]); } catch (_) {}
      }
      return;
    }

    // Button clicks coming off the now-playing playback row. Owned by
    // helpers/playbackButtons.js; falls through if the customId isn't ours.
    if (interaction.isButton && interaction.isButton()) {
      try {
        await playbackButtons.handle(interaction, bot, client, plexCommands);
      } catch (err) {
        logger.error('Button dispatch threw:', err.message || err);
      }
      return;
    }

    if (!interaction.isChatInputCommand || !interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    const cmd = plexCommands[name];
    if (!cmd || !cmd.slash) {
      try { await interaction.reply({ content: 'Unknown slash command.', ephemeral: true }); } catch (_) {}
      return;
    }

    try {
      await interaction.deferReply();
    } catch (err) {
      logger.error(`Failed to defer interaction for /${name}:`, err.message || err);
      return;
    }

    const query = slashRegistry.buildQueryString(interaction, cmd.slash);
    const fakeMessage = adaptInteraction(interaction, query);

    try {
      await cmd.process(bot, client, fakeMessage, query);
    } catch (err) {
      logger.error(`/${name} threw:`, err);
      try {
        await interaction.followUp({ content: '❌ Command failed — check the bot log.', ephemeral: true });
      } catch (_) {}
    }
  });
};
