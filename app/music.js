module.exports = function(client, bot) {
  // plex commands -------------------------------------------------------------
  const plexCommands = require('../commands');
  const logger = require('../helpers/logger.js');
  const { startHealthMonitor } = require('../helpers/healthMonitor.js');
  const { startEventServer } = require('../helpers/eventServer.js');
  const { startGamePresence } = require('../helpers/gamePresence.js');
  const { startKometaTheater } = require('../helpers/kometaTheater.js');
  const { startArchipelagoMonitor } = require('../helpers/archipelagoMonitor.js');
  const broadcast = require('../helpers/broadcast.js');
  const slashRegistry = require('../helpers/slashRegistry.js');
  const { adaptInteraction } = require('../helpers/interactionAdapter.js');
  const { MessageFlags } = require('discord.js');
  const playbackButtons = require('../helpers/playbackButtons.js');
  const tagInference = require('../helpers/tagInference.js');
  const commandLog = require('../helpers/commandLog.js');
  const interactionFallback = require('../helpers/interactionFallback.js');

  // Arguments are written to the command log before the command runs, and commandLog only knows
  // how to redact the static secrets in config/. A command that takes a secret typed at runtime
  // (a room password) declares `redactArgs` and gets to rewrite its own arg string first. A
  // redactor that throws must not fall back to the raw text, which is the thing being protected.
  // `secrets` are the values of slash options marked `sensitive` in the spec, stripped by value
  // because buildQueryString flattens options into a bare string and two optional options in a
  // row leave the secret at no fixed position.
  function loggableArgs(cmd, args, secrets = []) {
    let text = String(args == null ? '' : args);
    try {
      for (const secret of secrets) {
        if (secret) text = text.split(secret).join('[redacted]');
      }
      return cmd && typeof cmd.redactArgs === 'function' ? cmd.redactArgs(text) : text;
    } catch (err) {
      logger.warn('Arg redaction threw; logging a placeholder instead:', err.message || err);
      return '[redaction failed]';
    }
  }

  // Correlates the bot's own messages back to whatever command last ran in that channel, so the
  // log reads as "this was asked, this came back" instead of two unrelated streams. Correlation
  // is best-effort by design: a background broadcast lands with no invocation attached, which is
  // exactly what it is.
  const CORRELATION_WINDOW_MS = 2 * 60 * 1000;
  const recentInvocations = {
    entries: new Map(),
    set(channelId, id) {
      if (!channelId || !id) return;
      this.entries.set(channelId, { id, at: Date.now() });
      if (this.entries.size > 200) {
        const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.entries.delete(oldest[0]);
      }
    },
    get(channelId) {
      const hit = this.entries.get(channelId);
      if (!hit) return null;
      return Date.now() - hit.at <= CORRELATION_WINDOW_MS ? hit.id : null;
    }
  };

  // Everything the bot says, captured where it actually reaches Discord rather than at each of
  // the ~200 call sites that produce it.
  client.on('messageCreate', function(message) {
    if (!message.author || !client.user || message.author.id !== client.user.id) return;
    commandLog.recordOutput({
      id: recentInvocations.get(message.channelId),
      kind: (message.interaction || message.interactionMetadata) ? 'interaction-reply' : 'message',
      channelId: message.channelId,
      payload: { content: message.content, embeds: message.embeds, components: message.components }
    });
  });
  const channelClaims = require('../helpers/channelClaims.js');

  // when bot is ready
  client.once('clientReady', async function() {
    logger.info(`Bot ready — logged in as ${client.user.tag}`);
    startHealthMonitor(client);
    // Inbound listener for Kometa run + Playnite game-launch pushes. No-op unless enabled.
    startEventServer(client);
    // Broadcast games detected via Discord activity ("Playing X"). No-op unless enabled.
    startGamePresence(client);
    // "Kometa Theater" — narrate runs in-character by tailing meta.log. No-op unless enabled.
    startKometaTheater(client);
    // Re-opens any Archipelago watches saved in data/archipelago_watches.json. No-op
    // unless config.archipelagoEnabled is set.
    try {
      startArchipelagoMonitor(client);
    } catch (err) {
      logger.error('Archipelago monitor failed to start:', err.message || err);
    }
    // Announce boot to the broadcast channel so it's easy to confirm the bot is live.
    broadcast.broadcastStartup(client).catch((err) => logger.error('Startup broadcast failed:', err.message || err));
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
              const logId = commandLog.startInvocation({
                path: 'prefix',
                command: cmdTxt,
                args: loggableArgs(cmd, query),
                user: message.author && message.author.username,
                userId: message.author && message.author.id,
                channel: message.channel && message.channel.name,
                channelId: message.channel && message.channel.id,
                guildId: message.guild && message.guild.id
              });
              recentInvocations.set(message.channel && message.channel.id, logId);
              const startedAt = Date.now();
              try {
                // Commands are a mix of sync and async; Promise.resolve captures both, and the
                // dispatcher deliberately doesn't await so long-running games stay non-blocking.
                const result = cmd.process(bot, client, message, query);
                const awaited = !!(result && typeof result.then === 'function');
                Promise.resolve(result)
                  .then(() => commandLog.finishInvocation(logId, { ok: true, ms: Date.now() - startedAt, awaited }))
                  .catch((e) => {
                    logger.error(`Command "${cmdTxt}" threw:`, e);
                    commandLog.finishInvocation(logId, { ok: false, ms: Date.now() - startedAt, error: e });
                  });
              }
              catch (e) {
                logger.error(`Command "${cmdTxt}" threw:`, e);
                commandLog.finishInvocation(logId, { ok: false, ms: Date.now() - startedAt, error: e });
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
      const buttonLogId = commandLog.startInvocation({
        path: 'button',
        command: String(interaction.customId || '').split(':').slice(0, 2).join(':'),
        args: interaction.customId,
        user: interaction.user && interaction.user.username,
        userId: interaction.user && interaction.user.id,
        channel: interaction.channel && interaction.channel.name,
        channelId: interaction.channelId,
        guildId: interaction.guildId
      });
      recentInvocations.set(interaction.channelId, buttonLogId);
      const buttonStartedAt = Date.now();

      // Button handlers answer by editing the card in place, which Discord delivers as an update
      // — invisible to the messageCreate listener, so they report their replies directly.
      const onInteractionResponse = (payload) => commandLog.recordOutput({
        id: buttonLogId, kind: 'interaction-reply', channelId: interaction.channelId, payload
      });

      try {
        // Each handler returns false when the customId isn't its own, so ownership stays with
        // the module that defined the button.
        const claimed = await playbackButtons.handle(interaction, bot, client, plexCommands, { onInteractionResponse });
        if (!claimed) await tagInference.handle(interaction, { onInteractionResponse });
        commandLog.finishInvocation(buttonLogId, { ok: true, ms: Date.now() - buttonStartedAt });
      } catch (err) {
        commandLog.finishInvocation(buttonLogId, { ok: false, ms: Date.now() - buttonStartedAt, error: err });
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

    const query = slashRegistry.buildQueryString(interaction, cmd.slash);

    // Logged before the defer: a defer that fails is exactly the "This interaction failed" case
    // the log exists to explain, and starting after it would leave no record of the attempt.
    const logId = commandLog.startInvocation({
      path: 'slash',
      command: name,
      args: loggableArgs(cmd, query, slashRegistry.sensitiveValues(interaction, cmd.slash)),
      user: interaction.user && interaction.user.username,
      userId: interaction.user && interaction.user.id,
      channel: interaction.channel && interaction.channel.name,
      channelId: interaction.channelId,
      guildId: interaction.guildId
    });
    recentInvocations.set(interaction.channelId, logId);
    const startedAt = Date.now();

    try {
      // Commands can opt into a private (ephemeral) response via `slash.ephemeral` — used by
      // /config so the settings panel isn't posted for the whole channel to see.
      await interaction.deferReply(cmd.slash.ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
    } catch (err) {
      logger.error(`Failed to defer interaction for /${name}:`, err.message || err);
      commandLog.finishInvocation(logId, { ok: false, ms: Date.now() - startedAt, error: err });
      // The interaction can no longer be answered through its own token, so all Discord shows
      // the user is a bare "This interaction failed". An ordinary channel message is the only
      // route left, and this is worth explaining: the command did not break, it never ran.
      const said = await interactionFallback.explainFailedDefer(client, interaction, name, err,
        { ephemeral: !!cmd.slash.ephemeral });
      if (said) {
        commandLog.recordOutput({ id: logId, kind: 'message', channelId: interaction.channelId, payload: said });
      }
      return;
    }

    // The adapter reports the interaction response, which reaches Discord as an edit and so is
    // invisible to the messageCreate listener that captures ordinary channel messages.
    const fakeMessage = adaptInteraction(interaction, query, {
      onInteractionResponse: (payload) => commandLog.recordOutput({
        id: logId, kind: 'interaction-reply', channelId: interaction.channelId, payload
      })
    });

    try {
      const result = cmd.process(bot, client, fakeMessage, query);
      // Plenty of commands kick off async work and return synchronously; recording whether the
      // handler's own promise was awaited keeps the log from calling those a 1ms success.
      const awaited = !!(result && typeof result.then === 'function');
      await result;
      commandLog.finishInvocation(logId, { ok: true, ms: Date.now() - startedAt, awaited });
    } catch (err) {
      commandLog.finishInvocation(logId, { ok: false, ms: Date.now() - startedAt, error: err });
      logger.error(`/${name} threw:`, err);
      try {
        await interaction.followUp({ content: '❌ Command failed — check the bot log.', ephemeral: true });
      } catch (_) {}
    }
  });
};
