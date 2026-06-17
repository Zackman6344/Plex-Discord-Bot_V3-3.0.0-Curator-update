// helpers/channelClaims.js
//
// Lets an interactive feature (e.g. a Hitster game) declare that it is actively
// consuming raw channel messages through its own collector. The prefix-command
// dispatcher consults this before replying "unknown command", so in-game inputs
// like !bonus don't draw error noise while a game owns the channel.
//
// Features register a predicate keyed by channel id rather than imperatively
// claiming/releasing, so the claim is always derived from the feature's own
// live state — there's no separate flag to forget to clear.

const checkers = [];

function register(predicate) {
    if (typeof predicate === 'function') checkers.push(predicate);
}

function isClaimed(channelId) {
    return checkers.some((fn) => {
        try { return !!fn(channelId); } catch (_) { return false; }
    });
}

module.exports = { register, isClaimed };
