// helpers/interactionFallback.js
//
// What to say when a slash command could not be acknowledged.
//
// Discord gives three seconds to acknowledge an interaction. Past that its token is dead and
// nothing can be sent through it, not even an error, so all the user sees is Discord's own
// "This interaction failed" - which reads like the command broke when in fact it never started.
// An ordinary channel message is the only route left.
//
// 10062 "Unknown interaction" nearly always means the event reached the bot already expired
// rather than that the bot was slow. One measured case answered in 261 ms against a 3000 ms
// budget, with the bot idle for the seven minutes before it, which is why the advice for that
// case is simply to run it again rather than to go looking for a fault.

const logger = require('./logger.js');

const EXPIRED_CODE = 10062;

/** Did this failure mean the interaction was already dead when we answered it? */
function isExpired(err) {
    if (!err) return false;
    return err.code === EXPIRED_CODE || /Unknown interaction/i.test(err.message || '');
}

/**
 * The sentence to post. Deliberately does not echo the command's arguments: a slash command's
 * options are only visible to the person who ran it, and this message is public.
 */
function describe(name, err) {
    if (isExpired(err)) {
        return '\u231b `/' + name + '` reached me after Discord had already expired it, so I could not'
            + ' answer through it. Nothing ran, and running it again usually works.';
    }
    return '\u26a0\ufe0f I could not open a reply for `/' + name + '` ('
        + ((err && err.message) || 'unknown error') + '). Nothing ran, so try it again.';
}

/**
 * Post the explanation into the channel the command came from.
 * Never throws: this is the fallback path, and the failure it explains is already logged.
 * @returns {string|null} what was posted, or null if nothing could be
 */
async function explainFailedDefer(client, interaction, name, err) {
    const content = describe(name, err);
    try {
        const channel = interaction.channel
            || (client && client.channels && await client.channels.fetch(interaction.channelId).catch(() => null));
        if (!channel || typeof channel.send !== 'function') return null;
        await channel.send({ content, allowedMentions: { parse: [] } });
        return content;
    } catch (postErr) {
        logger.warn('Could not explain the failed defer for /' + name + ':', postErr.message || postErr);
        return null;
    }
}

module.exports = { isExpired, describe, explainFailedDefer, EXPIRED_CODE };
