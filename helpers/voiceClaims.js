// helpers/voiceClaims.js
//
// Which feature holds a guild's voice connection apart from the music queue: a Hitster game
// or an audiobook. Same pattern as helpers/channelClaims.js: each feature registers a predicate
// over its own live state, so there is no flag to forget to release when a game or a book ends
// some unusual way.
//
// The music queue is not a claimant. Its state lives on the Bot (`bot.musicBusy()`), and the
// runPlayback gate refuses music while a book holds the guild.

const claims = new Map();

/**
 * `predicate(guildId)` returns a short label naming who holds the guild's voice, or a falsy
 * value when the owner holds nothing there.
 *
 * Keyed by owner so a second registration replaces the first: `!restart` builds a new Bot and a
 * new book director, and the old director's predicate would otherwise keep claiming guilds from
 * sessions that no longer exist.
 */
function register(owner, predicate) {
	if (typeof owner !== 'string' || !owner || typeof predicate !== 'function') return;
	claims.set(owner, predicate);
}

/** The first owner holding `guildId` that is not in `ignore`, as `{ owner, label }`, or null. */
function holder(guildId, { ignore = [] } = {}) {
	if (guildId == null) return null;
	for (const [owner, predicate] of claims) {
		if (ignore.includes(owner)) continue;
		let label;
		// A broken predicate must not lock every other feature out of voice until a restart.
		try { label = predicate(guildId); } catch (_) { continue; }
		if (label) return { owner, label };
	}
	return null;
}

module.exports = { register, holder };
