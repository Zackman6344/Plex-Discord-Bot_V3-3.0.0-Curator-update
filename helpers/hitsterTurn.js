// helpers/hitsterTurn.js
//
// Pure, side-effect-free helpers for the hitster turn engine. Kept out of the
// command file so they can be unit-tested without a live Discord game (the
// command itself can't be — it needs a real voice channel and players).

/**
 * Resolve who an action is being performed on behalf of.
 *
 * `raw` is the value from the single autocomplete `player` field: either a real
 * Discord user id (a participant) or a `local:<name>` pseudo-player id. Empty
 * means "myself". The autocomplete source only offers actual game participants,
 * so the values are already canonical.
 *
 * @param {object} game - HitsterGame; reads playerOrder + localPlayers.
 * @param {{ raw?: string|null }} sel
 * @returns {{ id: string|null, kind: 'self'|'user'|'local'|'invalid', reason?: string }}
 */
function resolveTarget(game, sel) {
    const raw = sel && sel.raw;
    if (!raw || !String(raw).trim()) return { id: null, kind: 'self' };
    const val = String(raw).trim();

    if (val.startsWith('local:')) {
        if (game.localPlayers && game.localPlayers[val]) return { id: val, kind: 'local' };
        return { id: null, kind: 'invalid', reason: 'That local player is not in this game.' };
    }

    if (Array.isArray(game.playerOrder) && game.playerOrder.includes(val)) {
        return { id: val, kind: 'user' };
    }
    return { id: null, kind: 'invalid', reason: 'That player is not in this game.' };
}

/**
 * Authorize a proxy action under the "must be in the bot's voice channel" rule.
 *
 * Self-actions are always allowed (unchanged from the original game). Proxying
 * a real Discord user requires THAT user to be in the game's voice channel
 * (you can only act for someone who's actually present but not typing).
 * Proxying a local player requires the ACTOR to be in it — the local player has
 * no Discord identity, so they ride on the seat of whoever is hosting them.
 *
 * @param {object} game - HitsterGame; reads voiceChannel (a discord.js
 *   VoiceChannel whose `.members` reflects who is currently connected).
 * @param {string} actorId - the Discord id issuing the command.
 * @param {{ id: string|null, kind: string }} target - from resolveTarget.
 * @returns {{ ok: boolean, reason?: string }}
 */
function canProxy(game, actorId, target) {
    if (!target || target.kind === 'self' || target.id === actorId) return { ok: true };

    const vc = game.voiceChannel;
    if (!vc || !vc.members) {
        return { ok: false, reason: 'Cannot verify voice presence — the game has no active voice channel.' };
    }

    if (target.kind === 'local') {
        if (vc.members.has(actorId)) return { ok: true };
        return { ok: false, reason: 'You must be in the bot’s voice channel to play for a local player.' };
    }

    // real Discord user
    if (vc.members.has(target.id)) return { ok: true };
    return { ok: false, reason: 'You can only act for a player who is currently in the bot’s voice channel.' };
}

/**
 * Whether a bonus guess matches the target track's artist/album/title.
 * Punctuation-insensitive substring match, mirroring the original cleanString.
 */
function isBonusCorrect(targetObj, type, guess) {
    const clean = (s) => String(s).toLowerCase().replace(/[^\w\s]/g, '').trim();
    const field = targetObj && targetObj[type];
    if (!field) return false;
    return clean(field).includes(clean(guess));
}

module.exports = { resolveTarget, canProxy, isBonusCorrect };
