// helpers/gamePresence.js
// Broadcasts when the owner starts playing a game, detected via Discord's activity ("Playing X").
// Launcher-agnostic — works for Steam, Playnite, Epic, etc., anything Discord itself detects.
//
// REQUIRES two things or it does nothing:
//   1. config.gamePresenceEnabled = true
//   2. The privileged "Presence Intent" enabled for the bot in the Discord Developer Portal.
// The GuildPresences intent is only requested when the flag is on (see app/utils.js), so leaving
// this off can never stop the bot from logging in. This flag needs a restart to take effect
// (the intent is chosen when the client is constructed).
const { ActivityType } = require('discord.js');
const config = require('../config/config.js');
const logger = require('./logger.js');
const broadcast = require('./broadcast.js');

// Pure diff: which "Playing" games are present in `activities` that weren't in the `prev` set.
// Returns { now: Set(names), started: [names] } so the caller can both broadcast and update state.
function startedGames(prev, activities) {
    const now = new Set((activities || [])
        .filter((a) => a && a.type === ActivityType.Playing && a.name)
        .map((a) => a.name));
    const started = [...now].filter((name) => !prev.has(name));
    return { now, started };
}

function startGamePresence(client) {
    if (!config.gamePresenceEnabled) {
        logger.info('Game presence detection disabled (gamePresenceEnabled=false)');
        return;
    }

    const watchId = config.ownerId;
    const playing = new Map(); // userId -> Set(currently-playing game names)

    client.on('presenceUpdate', (oldPresence, newPresence) => {
        try {
            const p = newPresence;
            if (!p || !p.userId) return;
            if (watchId && p.userId !== watchId) return; // only announce the owner's games

            const prev = playing.get(p.userId) || new Set();
            const { now, started } = startedGames(prev, p.activities);
            playing.set(p.userId, now);

            for (const game of started) {
                const user = (p.member && p.member.displayName) || (p.user && p.user.username) || 'Someone';
                broadcast.broadcastGamePresence(client, { user, game }).catch(() => {});
            }
        } catch (err) {
            logger.error('presenceUpdate handler failed:', err.message || err);
        }
    });

    logger.info(`Game presence detection enabled — watching ${watchId ? 'owner' : 'no one (set ownerId)'} activity.`);
}

module.exports = { startGamePresence, startedGames };
