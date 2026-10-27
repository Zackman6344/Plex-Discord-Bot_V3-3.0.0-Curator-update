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
    try { require('../helpers/eventServer.js').stopEventServer(); } catch (_) {}
    try { require('../helpers/healthMonitor.js').stopHealthMonitor(); } catch (_) {}
    try { require('../helpers/kometaTheater.js').stopKometaTheater(); } catch (_) {}
    try { require('../helpers/archipelagoMonitor.js').detachArchipelagoMonitor(); } catch (_) {}
    // Before the music stops: a Hitster game ending here stops its own clip first.
    try { require('../helpers/restartHandoff.js').endAll(client); } catch (_) {}
    bot.songQueue = [];
    bot.stop();
    bot.destroy();
    client.destroy();
}

// !restart runs start() again in this process. A quitter per start() closed over its own bot,
// and the first one registered (the stopped bot's) exits the process before the next one runs,
// so one quitter is bound once and always stops whichever bot is running now. The error loggers
// are bound once too: a login retry runs start() again, and each run added another pair, so every
// later error was logged once per restart and retry.
let current = null;
let processHooksBound = false;

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

// A failed login has already destroyed its client, and discord.js leaves that client's gateway
// manager marked destroyed for good. Logged in again, its next destroy() would return early and
// leave the gateway open, so !restart would leave two clients answering every command. Each retry
// gets a fresh client and Bot instead, the way !restart builds them.
function loginFailed(err, attempt, bot, client) {
    const logger = require('../helpers/logger.js');
    const commandLog = require('../helpers/commandLog.js');
    const loginRetry = require('../helpers/loginRetry.js');
    const reason = (err && err.message) || String(err);

    if (!loginRetry.isRetryable(err)) {
        logger.error(`Discord login failed and will not be retried: ${reason}`);
        commandLog.recordEvent('login-failed', { attempt: attempt + 1, error: reason, retryInMs: null });
        // Not process.exit(1) straight away: on Windows that aborted on a libuv assertion
        // (UV_HANDLE_CLOSING, src\win\async.c) while the failed client was still closing, so the
        // process died on the abort rather than with code 1. With nothing left running it ends by
        // itself; the timer only covers something holding it open.
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 5000).unref();
        return;
    }

    const delay = loginRetry.retryDelayMs(attempt);
    logger.warn(`Discord login failed (attempt ${attempt + 1}): ${reason}. Trying again in ${delay / 1000} s.`);
    commandLog.recordEvent('login-failed', { attempt: attempt + 1, error: reason, retryInMs: delay });
    setTimeout(() => {
        stop(bot, client);
        start(attempt + 1);
    }, delay);
}

function start(attempt = 0){
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

    client.login(keys.botToken).catch((err) => loginFailed(err, attempt, bot, client));

    if (!processHooksBound) {
        processHooksBound = true;

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

        process.on('SIGTERM', quitter);
        process.on('SIGINT', quitter);
    }
}

exports.stop = stop;
exports.start = start;