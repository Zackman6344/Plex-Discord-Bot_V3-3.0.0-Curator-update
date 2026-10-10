'use strict';

function stop(bot, client) {
    // !restart builds a second Bot in this same process. bot.destroy() leaves a playing track
    // alone, so this one's player and voice connection played on where no Stop could reach them.
    // Stopped here, while the gateway is still up, the connection's destroy also leaves voice.
    // The book goes first: its saves are synchronous, and process.exit follows straight after.
    try { if (bot.books) bot.books.shutdown(); } catch (_) {}
    // After the books: their stop() ends each session, which queues the stub edit for any open
    // read-along DM page. On a signal the process exits before that edit is sent, and the left-over
    // page is stubbed or adopted when it is next clicked.
    try { if (bot.readAlong) bot.readAlong.shutdown(); } catch (_) {}
    bot.songQueue = [];
    bot.stop();
    bot.destroy();
    client.destroy();
}

// !restart runs start() again in this process. A quitter per start() closed over its own bot,
// and the first one registered (the stopped bot's) exits the process before the next one runs,
// so one quitter is bound once and always stops whichever bot is running now.
let current = null;
let signalsBound = false;

async function quitter(){
    const logger = require('../helpers/logger.js');
    try {
       logger.info('Bot shutdown');
       if (current) stop(current.bot, current.client);
    } catch (e){
       logger.error('Error during shutdown:', e);
    } finally {
       process.exit(0);
    }
}

function start(){
    // packages --------------------------------------------------------------------
    const { Client, GatewayIntentBits, Partials } = require('discord.js');
    const Bot = require('./bot.js');
    const logger = require('../helpers/logger.js');
    // my keys ---------------------------------------------------------------------
    var keys = require('../config/keys.js');
    var config = require('../config/config.js');

    // Before the login, so the voice timer has its priority from the first track. Both follow
    // /config live, and both are safe to repeat when !restart runs this again.
    require('../helpers/processPriority.js').bindToConfig(config);
    require('../helpers/voiceHealth.js').bindToConfig(config);

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
    current = { bot, client };
    // bot functions ---------------------------------------------------------------
    require('./music.js')(client, bot);

    client.login(keys.botToken);

    // Catch anything that escapes a try/catch or a .catch() so the bot doesn't die mid-session.
    // Node's default would crash the process on an uncaught exception; for a long-running bot we'd
    // rather log it loudly and keep running.
    // Also recorded in the command log: this is where a failure with no command behind it shows
    // up (a queue advancing, a timer firing), and the console line alone gave no way to see what
    // the bot had been doing at the time.
    const commandLog = require('../helpers/commandLog.js');

    process.on('uncaughtException', (err, origin) => {
        logger.error(`Uncaught exception (${origin}):`, err && err.stack ? err.stack : err);
        commandLog.recordEvent('uncaught-exception', { origin, error: (err && err.stack) || String(err) });
    });

    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
        commandLog.recordEvent('unhandled-rejection', { error: (reason && reason.stack) || String(reason) });
    });

    if (!signalsBound) {
        signalsBound = true;
        process.on('SIGTERM', quitter);
        process.on('SIGINT', quitter);
    }
}

exports.stop = stop;
exports.start = start;