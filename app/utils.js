'use strict';

function stop(bot, client) {
    bot.destroy();
    client.destroy();
}

function start(){
    // packages --------------------------------------------------------------------
    const { Client, GatewayIntentBits, Partials } = require('discord.js');
    const Bot = require('./bot.js');
    const logger = require('../helpers/logger.js');
    // my keys ---------------------------------------------------------------------
    var keys = require('../config/keys.js');
    var config = require('../config/config.js');

    // discord client --------------------------------------------------------------

    const intents = [
       GatewayIntentBits.Guilds,
       GatewayIntentBits.GuildMessages,
       GatewayIntentBits.GuildVoiceStates,
       GatewayIntentBits.MessageContent,
       GatewayIntentBits.DirectMessages // <-- Allows the bot to receive DMs
    ];
    // Game-presence detection needs the privileged GuildPresences intent. Only request it when the
    // feature is enabled — otherwise Discord rejects login with "Used disallowed intents" for bots
    // that haven't turned the Presence Intent on in the developer portal.
    if (config.gamePresenceEnabled) intents.push(GatewayIntentBits.GuildPresences);

    const client = new Client({
       intents,
       partials: [
          Partials.Channel, // <-- Forces the bot to listen to uncached DM channels
          Partials.Message
       ]
    });
    const bot = new Bot(client);
    // bot functions ---------------------------------------------------------------
    require('./music.js')(client, bot);

    client.login(keys.botToken);

    async function quitter(){
       try {
          logger.info('Bot shutdown');
          stop(bot, client);
       } catch (e){
          logger.error('Error during shutdown:', e);
       } finally {
          process.exit(0);
       }
    }

    // Catch anything that escapes a try/catch or a .catch() so the bot doesn't die mid-session.
    // Node's default would crash the process on an uncaught exception; for a long-running bot we'd
    // rather log it loudly and keep running.
    process.on('uncaughtException', (err, origin) => {
        logger.error(`Uncaught exception (${origin}):`, err && err.stack ? err.stack : err);
    });

    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
    });

    process.on('SIGTERM', quitter);

    process.on('SIGINT', quitter);
}

exports.stop = stop;
exports.start = start;