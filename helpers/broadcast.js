// helpers/broadcast.js
// Turns inbound events (Kometa runs, Playnite game launches) into Discord embeds and posts
// them to config.broadcastChannelId. The embed *builders* are pure (no I/O) so they can be
// unit-tested; the *senders* resolve the channel and swallow send failures so a Discord
// hiccup never bubbles back into the HTTP handler that called them.
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config/config.js');
const logger = require('./logger.js');
const kometaTheater = require('./kometaTheater.js');

const COLOR_RUN = 0x5865F2;     // blurple — a normal Kometa run
const COLOR_ERROR = 0xED4245;   // red — Kometa error event
const COLOR_GAME = 0x57F287;    // green — game launched
const COLOR_GROW = 0x57F287;    // green — a collection grew during a run
const COLOR_CREATED = 0xFEE75C; // gold — a brand-new collection this run

// Discord caps attachments (8 MB on the free tier); cover art is well under this. We reject
// anything larger rather than fail the whole send.
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const COVER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// One number → one "Label: N" line, but only when Kometa actually sent it. Kometa omits
// zero-value fields from its payload, so `Number.isFinite` doubles as "did something happen".
function statLine(label, value) {
    return Number.isFinite(value) ? `${label}: ${value}` : null;
}

function fieldFromLines(name, lines) {
    const kept = lines.filter(Boolean);
    return kept.length ? { name, value: kept.join('\n'), inline: true } : null;
}

function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Kometa's additions/removals/*_adds arrays are objects with a `title`. Join the first `max`
// titles into a comma list, appending "+N more" for the overflow. Returns null when empty.
function titleList(items, max) {
    const names = (Array.isArray(items) ? items : []).map((i) => i && i.title).filter(Boolean);
    if (!names.length) return null;
    const shown = names.slice(0, max);
    const extra = names.length - shown.length;
    return truncate(shown.join(', ') + (extra > 0 ? `, +${extra} more` : ''), 1024);
}

// payload is the raw JSON Kometa POSTs. See kometa.wiki webhooks docs for the field names.
function buildKometaEmbed(payload) {
    const p = payload || {};
    const event = p.event || 'run_end';

    // Per-collection "changes" events are their own shape; delegate so callers can build any
    // Kometa embed through this one entry point.
    if (event === 'changes') return buildKometaChangesEmbed(p);

    if (event === 'error') {
        return new EmbedBuilder()
            .setColor(COLOR_ERROR)
            .setTitle('⚠️ Kometa error')
            .setDescription(String(p.error || 'Kometa reported an error during its run.').slice(0, 4000))
            .setTimestamp();
    }

    if (event === 'run_start') {
        return new EmbedBuilder()
            .setColor(COLOR_RUN)
            .setTitle('📚 Kometa run started')
            .setDescription(p.start_time ? `Started at ${p.start_time}.` : 'A Kometa run just kicked off.')
            .setTimestamp();
    }

    // run_end (default)
    const embed = new EmbedBuilder()
        .setColor(COLOR_RUN)
        .setTitle('📚 Kometa run finished')
        .setTimestamp();

    const fields = [
        fieldFromLines('⏱ Run time', [p.run_time ? String(p.run_time) : null]),
        fieldFromLines('📦 Collections', [
            statLine('Created', p.collections_created),
            statLine('Modified', p.collections_modified),
            statLine('Deleted', p.collections_deleted),
        ]),
        fieldFromLines('🎬 Items', [
            statLine('Added', p.items_added),
            statLine('Removed', p.items_removed),
        ]),
        fieldFromLines('⬇️ Requested', [
            statLine('Radarr', p.added_to_radarr),
            statLine('Sonarr', p.added_to_sonarr),
        ]),
    ].filter(Boolean);

    if (fields.length) {
        embed.addFields(fields);
    } else {
        embed.setDescription('Finished with no changes.');
    }
    return embed;
}

// A single "changes" event: one collection/playlist that gained/lost items during the run.
// Shows what grew, and any items Kometa is requesting from Radarr/Sonarr for the server.
function buildKometaChangesEmbed(payload) {
    const p = payload || {};
    const name = p.collection || p.playlist || 'Collection';
    const kind = p.playlist ? 'playlist' : 'collection';
    const addCount = Array.isArray(p.additions) ? p.additions.length : 0;
    const remCount = Array.isArray(p.removals) ? p.removals.length : 0;
    const recCount = (Array.isArray(p.radarr_adds) ? p.radarr_adds.length : 0)
        + (Array.isArray(p.sonarr_adds) ? p.sonarr_adds.length : 0);

    const embed = new EmbedBuilder().setTimestamp();
    if (p.created) {
        embed.setColor(COLOR_CREATED).setTitle(`✨ New ${kind}: ${name}`);
    } else if (addCount > 0) {
        embed.setColor(COLOR_GROW).setTitle(`📈 ${name} grew by ${addCount}`);
    } else if (recCount > 0) {
        embed.setColor(COLOR_RUN).setTitle(`📥 ${name}: ${recCount} requested for the server`);
    } else {
        embed.setColor(COLOR_RUN).setTitle(`🔄 ${name} updated`);
    }

    if (p.library_name) embed.addFields({ name: 'Library', value: String(p.library_name), inline: true });

    const added = titleList(p.additions, 12);
    if (added) embed.addFields({ name: `➕ Added (${addCount})`, value: added, inline: false });

    const removed = titleList(p.removals, 8);
    if (removed) embed.addFields({ name: `➖ Removed (${remCount})`, value: removed, inline: false });

    const recs = titleList([...(p.radarr_adds || []), ...(p.sonarr_adds || [])], 12);
    if (recs) embed.addFields({ name: '📥 Requested for the server', value: recs, inline: false });

    if (p.poster_url) embed.setThumbnail(String(p.poster_url));
    return embed;
}

// Gate for per-collection "changes" broadcasts so a big run doesn't spam every tiny tweak.
// Worth posting when: a collection was created, Kometa is requesting items for the server, or
// it grew by at least config.kometaChangesMinAdds (floored at 1 — pure removals never qualify).
function isNoteworthyChange(payload) {
    const p = payload || {};
    if (p.created) return true;
    const recs = (Array.isArray(p.radarr_adds) ? p.radarr_adds.length : 0)
        + (Array.isArray(p.sonarr_adds) ? p.sonarr_adds.length : 0);
    if (recs > 0) return true;
    const adds = Array.isArray(p.additions) ? p.additions.length : 0;
    const min = Number.isFinite(config.kometaChangesMinAdds) ? config.kometaChangesMinAdds : 1;
    return adds >= Math.max(1, min);
}

// game is { name, source, platform }. coverAttachmentName, when given, wires the embed
// thumbnail to a file the sender attaches alongside (kept out of here so this stays pure).
function buildGameLaunchEmbed(game, coverAttachmentName) {
    const g = game || {};
    const embed = new EmbedBuilder()
        .setColor(COLOR_GAME)
        .setTitle(`🎮 ${g.name || 'A game'} launched`)
        .setDescription('Now playing on the host PC.')
        .setTimestamp();

    const fields = [];
    fields.push({ name: '🛒 Store', value: String(g.source || 'Local'), inline: true });
    if (g.platform) fields.push({ name: '🖥 Platform', value: String(g.platform), inline: true });
    embed.addFields(fields);

    if (coverAttachmentName) embed.setThumbnail(`attachment://${coverAttachmentName}`);
    return embed;
}

// --- senders -------------------------------------------------------------------------------

// Which channel a broadcast type posts to: its dedicated channel if set, else the shared
// broadcastChannelId fallback. Pure (reads config only) so the routing is unit-testable.
function pickChannelId(type) {
    if (type === 'kometa') return config.kometaChannelId || config.broadcastChannelId || '';
    if (type === 'game') return config.gameLaunchChannelId || config.broadcastChannelId || '';
    return config.broadcastChannelId || '';
}

const channelCache = new Map(); // channelId -> channel (keyed by id so runtime config changes refetch)
const warnedTypes = new Set();

async function resolveChannelById(client, id) {
    if (!id) return null;
    if (channelCache.has(id)) return channelCache.get(id);
    try {
        const channel = await client.channels.fetch(id);
        if (!channel || typeof channel.send !== 'function') {
            logger.warn(`Broadcast channel ${id} is not a sendable text channel — skipping.`);
            return null;
        }
        channelCache.set(id, channel);
        return channel;
    } catch (err) {
        logger.warn(`Could not fetch broadcast channel ${id}:`, err.message || err);
        return null;
    }
}

async function resolveChannel(client, type) {
    const id = pickChannelId(type);
    if (!id) {
        if (!warnedTypes.has(type)) {
            logger.warn(`${type} broadcast requested but no channel is configured — skipping.`);
            warnedTypes.add(type);
        }
        return null;
    }
    return resolveChannelById(client, id);
}

// The single channel the boot confirmation goes to: the general broadcast channel if set,
// else the first configured type channel. Deliberately ONE channel — a "system started" card
// shouldn't show up in both the Kometa and game channels.
function startupChannelId() {
    return config.broadcastChannelId || config.kometaChannelId || config.gameLaunchChannelId || '';
}

function buildStartupEmbed() {
    const embed = new EmbedBuilder()
        .setColor(COLOR_GAME) // green
        .setTitle('✅ System has started')
        .setDescription(`**${config.serverName || 'The bot'}** is online and ready for broadcasts.`)
        .setTimestamp();

    // Event listener status. Lazy require avoids a circular dependency with eventServer.js
    // (which requires this module at load time).
    let es = null;
    try { es = require('./eventServer.js').getStatus(); } catch (_) { /* not available */ }
    if (es) {
        const line = es.listening ? `🟢 Listening on 127.0.0.1:${es.port}`
            : es.enabled ? `🟡 Enabled on :${es.port} (starting)`
            : '🚫 Disabled';
        embed.addFields({ name: 'Event listener', value: line, inline: false });
    }

    const enabled = [];
    if (config.broadcastKometa) enabled.push('Kometa run summaries');
    if (config.broadcastKometaChanges) enabled.push('Kometa live changes');
    if (config.broadcastGameLaunch) enabled.push('Game launches');
    embed.addFields({ name: 'Broadcasts enabled', value: enabled.length ? enabled.join(', ') : 'None', inline: false });

    return embed;
}

// Posts a "System has started" card to a single broadcast channel so you can confirm the bot is
// live. A short delay lets the event listener finish binding before we report its status.
async function broadcastStartup(client) {
    if (!config.broadcastStartup) return;
    const id = startupChannelId();
    if (!id) return;
    await new Promise((r) => setTimeout(r, 1000));
    const channel = await resolveChannelById(client, id);
    if (!channel) return;
    try {
        await channel.send({ embeds: [buildStartupEmbed()] });
    } catch (err) {
        logger.warn(`Failed to post startup broadcast to ${id}:`, err.message || err);
    }
}

// A game detected via Discord activity ("Playing X"). info is { user, game }.
function buildGamePresenceEmbed(info) {
    const i = info || {};
    return new EmbedBuilder()
        .setColor(COLOR_GAME)
        .setTitle(`🎮 ${i.game || 'A game'}`)
        .setDescription(`**${i.user || 'Someone'}** started playing.`)
        .setTimestamp();
}

async function broadcastGamePresence(client, info) {
    const channel = await resolveChannel(client, 'game');
    if (!channel) return;
    try {
        await channel.send({ embeds: [buildGamePresenceEmbed(info)] });
    } catch (err) {
        logger.warn('Failed to post game-presence broadcast:', err.message || err);
    }
}

// Validate a Playnite cover path (absolute image file, sane size) and wrap it for Discord.
// Returns { attachment, name } or null — a bad/missing cover just yields a text-only embed.
function resolveCover(coverPath) {
    if (!coverPath || typeof coverPath !== 'string') return null;
    try {
        const ext = path.extname(coverPath).toLowerCase();
        if (!COVER_EXTS.has(ext)) return null;
        const stat = fs.statSync(coverPath);
        if (!stat.isFile() || stat.size > MAX_COVER_BYTES) return null;
        const name = `cover${ext}`;
        return { attachment: new AttachmentBuilder(coverPath, { name }), name };
    } catch (err) {
        logger.debug('Cover art unavailable:', err.message || err);
        return null;
    }
}

async function broadcastKometaRun(client, payload) {
    const p = payload || {};

    // Theater mode: hand run boundaries, changes and errors to the in-character narrator and
    // swallow the rest (e.g. Kometa's `version` webhook). Errors are handed over rather than
    // dropped so a run that dies partway still closes out — the theater batches them into its
    // sign-off instead of posting one card per config warning. It is the only output while on.
    if (kometaTheater.isEnabled()) {
        if (p.event === 'changes') kometaTheater.onChanges(p);
        else if (p.event === 'run_start') kometaTheater.onRunStart(p);
        else if (p.event === 'run_end') kometaTheater.onRunEnd(p);
        else if (p.event === 'error') kometaTheater.onError(p);
        return;
    }

    // Per-event gating: live per-collection "changes" and the run summaries (start/end/error)
    // toggle independently, so you can have one without the other.
    if (p.event === 'changes') {
        if (!config.broadcastKometaChanges || !isNoteworthyChange(p)) return;
    } else if (!config.broadcastKometa) {
        return;
    }

    const channel = await resolveChannel(client, 'kometa');
    if (!channel) return;
    try {
        await channel.send({ embeds: [buildKometaEmbed(p)] });
    } catch (err) {
        logger.warn('Failed to post Kometa broadcast:', err.message || err);
    }
}

async function broadcastGameLaunch(client, game) {
    const channel = await resolveChannel(client, 'game');
    if (!channel) return;
    const cover = resolveCover(game && game.cover);
    try {
        await channel.send({
            embeds: [buildGameLaunchEmbed(game, cover ? cover.name : null)],
            files: cover ? [cover.attachment] : [],
        });
    } catch (err) {
        logger.warn('Failed to post game-launch broadcast:', err.message || err);
    }
}

module.exports = {
    buildKometaEmbed,
    buildKometaChangesEmbed,
    isNoteworthyChange,
    buildGameLaunchEmbed,
    buildStartupEmbed,
    buildGamePresenceEmbed,
    pickChannelId,
    startupChannelId,
    broadcastKometaRun,
    broadcastGameLaunch,
    broadcastGamePresence,
    broadcastStartup,
};
