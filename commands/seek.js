// commands/seek.js

/**
 * Parses various human-readable time strings into milliseconds.
 * Supports: "90" (seconds), "1:30" (mm:ss), "1h30m15s", "1m30s"
 */
function parseToMilliseconds(input) {
    let ms = 0;
    const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
    const colonRegex = /^(\d+):(\d{2})(?::(\d{2}))?$/;

    // Pure number (assume seconds)
    if (!isNaN(input) && !input.includes(':')) {
        return parseInt(input) * 1000;
    }

    // Colon format (mm:ss or hh:mm:ss)
    const colonMatch = input.match(colonRegex);
    if (colonMatch) {
        if (colonMatch[3]) { // hh:mm:ss
            ms += parseInt(colonMatch[1] || 0) * 3600000;
            ms += parseInt(colonMatch[2] || 0) * 60000;
            ms += parseInt(colonMatch[3] || 0) * 1000;
        } else { // mm:ss
            ms += parseInt(colonMatch[1] || 0) * 60000;
            ms += parseInt(colonMatch[2] || 0) * 1000;
        }
        return ms;
    }

    // Letter format (1m30s)
    const match = input.match(timeRegex);
    if (match && match[0] !== "") {
        ms += parseInt(match[1] || 0) * 3600000; // Hours
        ms += parseInt(match[2] || 0) * 60000;   // Minutes
        ms += parseInt(match[3] || 0) * 1000;    // Seconds
        return ms;
    }

    return null;
}

module.exports = {
    name: 'seek',
    command: {
        usage: '!seek [time]',
        description: 'Seek to a specific time in the currently playing track (e.g., 1:30, 90, 1m30s).',
        process: async function(bot, client, message, query) {

            if (!bot.isPlaying || bot.songQueue.length === 0) {
                return message.reply("There is no music currently playing.");
            }

            if (!bot.songQueue[0].key) {
                return message.reply("Seeking is currently only supported for Plex tracks, not YouTube URLs.");
            }

            if (!query) {
                return message.reply(`Please provide a time to seek to (e.g., \`${bot.config.caracteres_commande}seek 1:30\`).`);
            }

            const ms = parseToMilliseconds(query.trim().toLowerCase());

            if (ms === null || isNaN(ms)) {
                return message.reply("Invalid time format. Try `1:30`, `90`, or `1m30s`.");
            }

            // Flag the current song for the dispatcher function
            bot.songQueue[0].isSeeking = true;
            bot.songQueue[0].seekOffset = ms;

            message.channel.send(`⏩ Seeking to **${query.trim()}**...`);

            // Stopping the dispatcher manually triggers the AudioPlayerStatus.Idle event,
            // which executes dispatcherFunc() in app/bot.js, cleanly applying the seek.
            if (bot.dispatcher) {
                bot.dispatcher.stop();
            }
        }
    }
};