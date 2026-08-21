const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const sidecar = require('../helpers/tagSidecar.js');
const recentPicks = require('../helpers/recentPicks.js');
const plexTags = require('../helpers/plexTags.js');
const logger = require('../helpers/logger.js');

const EXPORT_FILE = path.join(__dirname, '..', 'data', 'inferred_tags.export.json');
const COVERAGE_SAMPLE = 40;

function formatEntry(e) {
    const bits = [];
    if (e.moods && e.moods.length) bits.push(`moods: ${e.moods.join(', ')}`);
    if (e.genres && e.genres.length) bits.push(`genres: ${e.genres.join(', ')}`);
    if (e.styles && e.styles.length) bits.push(`styles: ${e.styles.join(', ')}`);
    const state = e.supersededAt ? ' — *retired, Plex has official data now*' : '';
    return `**${e.title || '?'}** — ${e.artist || '?'} (id \`${e.ratingKey}\`)${state}\n> ${bits.join(' | ') || '_none_'}`;
}

/**
 * Estimate how much of the library Plex has tags for. An exact figure would mean a per-track
 * fetch across the whole library, so this samples and says so rather than pretending to precision.
 */
async function estimateCoverage() {
    const vocab = await plexTags.getVocabulary();
    if (!vocab.sectionKey) return null;

    const total = await plexTags.countTracks(vocab.sectionKey);
    const sample = await plexTags.sampleRandomTracks(vocab.sectionKey, COVERAGE_SAMPLE, total);
    const detailed = await plexTags.fetchTracksByRatingKeys(sample.map((t) => t.ratingKey).slice(0, COVERAGE_SAMPLE));

    if (detailed.length === 0) return { total, sampled: 0 };

    const has = (t, f) => Array.isArray(t[f]) && t[f].length > 0;
    const withMood = detailed.filter((t) => has(t, 'Mood')).length;
    const withGenre = detailed.filter((t) => has(t, 'Genre')).length;
    const untagged = detailed.filter((t) => !has(t, 'Mood') && !has(t, 'Genre') && !has(t, 'Style')).length;

    return {
        total,
        sampled: detailed.length,
        moodPct: Math.round((100 * withMood) / detailed.length),
        genrePct: Math.round((100 * withGenre) / detailed.length),
        untaggedPct: Math.round((100 * untagged) / detailed.length)
    };
}

module.exports = {
    name: 'tags',
    command: {
        usage: '!tags [stats/list/coverage/export/discovery <n>/memory <n>/forget <id>]',
        description: 'Review the locally inferred track tags, library tag coverage, and vibe rotation settings.',
        slash: {
            description: 'Inferred tags, library coverage, and rotation settings',
            subcommands: [
                { name: 'stats',    description: 'What the local sidecar holds', options: [] },
                { name: 'list',     description: 'Show the most recently saved inferred tags', options: [] },
                { name: 'coverage', description: 'Estimate what share of the library Plex has tagged', options: [] },
                { name: 'export',   description: 'Write a portable copy for use outside the bot', options: [] },
                { name: 'discovery', description: 'Percent of each vibe queue reserved for untagged tracks',
                  options: [{ name: 'percent', type: 'INTEGER', required: false, description: '0-100 (blank to show the current value)' }] },
                { name: 'memory',   description: 'How many recent picks to avoid repeating',
                  options: [{ name: 'tracks', type: 'INTEGER', required: false, description: '0-2000, 0 disables rotation (blank to show)' }] },
                { name: 'forget',   description: 'Delete one inferred entry',
                  options: [{ name: 'id', type: 'STRING', required: true, description: 'The track id shown by /tags list' }] }
            ]
        },
        process: async function(bot, client, message, query) {
            const words = String(query || '').trim().split(/\s+/).filter(Boolean);
            const action = (words[0] || 'stats').toLowerCase();

            try {
                if (action === 'forget') {
                    const id = words[1];
                    if (!id) return message.reply('Give me the track id to forget — `/tags list` shows them.');
                    return message.reply(sidecar.forget(id)
                        ? `🗑️ Forgot the inferred tags for track \`${id}\`.`
                        : `Nothing stored for track \`${id}\`.`);
                }

                if (action === 'discovery' || action === 'memory') {
                    const key = action === 'discovery' ? 'discoveryPercent' : 'repeatMemory';
                    const current = sidecar.getSettings();

                    if (words[1] === undefined) {
                        return message.reply(action === 'discovery'
                            ? `🎲 **${current.discoveryPercent}%** of each vibe queue is reserved for untagged wildcard tracks. Set it with \`/tags discovery percent:<0-100>\`.`
                            : `🔁 Avoiding repeats across the last **${current.repeatMemory}** tracks. Set it with \`/tags memory tracks:<0-2000>\` (0 disables).`);
                    }

                    const result = sidecar.setSetting(key, words[1]);
                    if (!result.ok) return message.reply(`❌ Couldn't set that — ${result.reason}.`);
                    return message.reply(action === 'discovery'
                        ? `🎲 Discovery quota set to **${result.value}%** of each vibe queue.`
                        : `🔁 Repeat memory set to **${result.value}** tracks${result.value === 0 ? ' (rotation disabled)' : ''}.`);
                }

                if (action === 'export') {
                    const entries = sidecar.activeEntries();
                    if (entries.length === 0) return message.reply('Nothing to export yet — no inferred tags have been approved.');

                    const payload = {
                        exportedAt: new Date().toISOString(),
                        note: 'Inferred tags only. Wherever Plex has its own data for a dimension, Plex is authoritative and this file should be ignored for it.',
                        schema: { ratingKey: 'Plex rating key', file: 'absolute path on the Plex host, when known', moods: '[]', genres: '[]', styles: '[]' },
                        tracks: entries.map((e) => ({
                            ratingKey: e.ratingKey,
                            file: e.file || null,
                            title: e.title, artist: e.artist, album: e.album,
                            moods: e.moods || [], genres: e.genres || [], styles: e.styles || [],
                            source: e.source, approvedAt: e.at
                        }))
                    };

                    try {
                        fs.writeFileSync(EXPORT_FILE, JSON.stringify(payload, null, 2));
                    } catch (err) {
                        logger.error('tags export failed:', err.message || err);
                        return message.reply('❌ Could not write the export file — check the bot log.');
                    }

                    const withPath = payload.tracks.filter((t) => t.file).length;
                    return message.reply(
                        `📤 Exported **${payload.tracks.length}** tracks to \`${EXPORT_FILE}\`.\n` +
                        `**${withPath}** include the file path on the Plex host, so external tooling can match them without Plex ids.`
                    );
                }

                if (action === 'coverage') {
                    await message.channel.sendTyping().catch(() => {});
                    const cov = await estimateCoverage();
                    if (!cov) return message.reply('❌ Could not reach the music library.');
                    if (!cov.sampled) return message.reply('❌ Could not sample the library — is Plex reachable?');

                    const s = sidecar.stats();
                    const tuning = sidecar.getSettings();
                    const estimatedUntagged = Math.round((cov.untaggedPct / 100) * cov.total);

                    const embed = new EmbedBuilder()
                        .setColor(0x4169c8)
                        .setTitle('📊 Library tag coverage')
                        .setDescription(
                            `**${cov.total.toLocaleString()}** tracks in the music library.\n` +
                            `Estimated from a random sample of ${cov.sampled}:\n\n` +
                            `• **${cov.moodPct}%** have moods in Plex\n` +
                            `• **${cov.genrePct}%** have a genre\n` +
                            `• **${cov.untaggedPct}%** have nothing at all — roughly **${estimatedUntagged.toLocaleString()}** tracks that tag search can never reach\n\n` +
                            `The sidecar currently covers **${s.active}** of those. ` +
                            `**${tuning.discoveryPercent}%** of each vibe queue is reserved for untagged wildcards, ` +
                            `and repeats are avoided across the last **${tuning.repeatMemory}** picks.`
                        )
                        .setFooter({ text: 'Sampled, not exhaustive — an exact figure would mean fetching all 14k tracks individually.' });
                    return message.channel.send({ embeds: [embed] });
                }

                if (action === 'list') {
                    const entries = sidecar.list(10);
                    if (entries.length === 0) {
                        return message.reply('No inferred tags stored yet. `/vibe` proposes them after a run, and nothing is saved unless you approve it.');
                    }
                    const embed = new EmbedBuilder()
                        .setColor(0x4169c8)
                        .setTitle('🏷️ Locally inferred tags')
                        .setDescription(entries.map(formatEntry).join('\n\n').slice(0, 4000))
                        .setFooter({ text: 'These fill gaps only. Wherever Plex has real data, Plex wins.' });
                    return message.channel.send({ embeds: [embed] });
                }

                const s = sidecar.stats();
                const rot = recentPicks.stats(sidecar.getSettings().repeatMemory);
                const embed = new EmbedBuilder()
                    .setColor(0x4169c8)
                    .setTitle('🏷️ Inferred tag sidecar')
                    .setDescription(
                        `**${s.active}** track${s.active === 1 ? '' : 's'} backed by inferred tags` +
                        (s.superseded ? `, **${s.superseded}** retired since Plex supplied real data` : '') +
                        (s.pending ? `, **${s.pending}** awaiting your approval` : '') + '.\n\n' +
                        `**${s.moods}** moods · **${s.genres}** genres · **${s.styles}** styles\n` +
                        `**${s.withFilePath}** carry the file path for use outside the bot (\`/tags export\`).\n\n` +
                        `Rotation is remembering **${rot.remembered}** recent picks.\n\n` +
                        'Nothing here is written to Plex — it is a local layer consulted only where Plex has nothing.'
                    )
                    .setFooter({ text: s.file });
                return message.channel.send({ embeds: [embed] });
            } catch (err) {
                logger.error('/tags failed:', err);
                return message.reply('❌ That failed — check the bot log.').catch(() => {});
            }
        }
    }
};
