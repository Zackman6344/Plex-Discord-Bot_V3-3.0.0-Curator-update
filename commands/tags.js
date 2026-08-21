const { EmbedBuilder } = require('discord.js');
const sidecar = require('../helpers/tagSidecar.js');
const logger = require('../helpers/logger.js');

function formatEntry(e) {
    const bits = [];
    if (e.moods && e.moods.length) bits.push(`moods: ${e.moods.join(', ')}`);
    if (e.genres && e.genres.length) bits.push(`genres: ${e.genres.join(', ')}`);
    if (e.styles && e.styles.length) bits.push(`styles: ${e.styles.join(', ')}`);
    const state = e.supersededAt ? ' — *retired, Plex has official data now*' : '';
    return `**${e.title || '?'}** — ${e.artist || '?'} (id \`${e.ratingKey}\`)${state}\n> ${bits.join(' | ') || '_none_'}`;
}

module.exports = {
    name: 'tags',
    command: {
        usage: '!tags [list/stats/forget <id>]',
        description: 'Review the locally inferred track tags used to fill gaps in Plex metadata.',
        slash: {
            description: 'Review locally inferred track tags',
            subcommands: [
                { name: 'list',   description: 'Show the most recently saved inferred tags', options: [] },
                { name: 'stats',  description: 'How much inferred metadata is stored', options: [] },
                { name: 'forget', description: 'Delete one inferred entry',
                  options: [{ name: 'id', type: 'STRING', required: true, description: 'The track id shown by /tags list' }] }
            ]
        },
        process: async function(bot, client, message, query) {
            const words = String(query || '').trim().split(/\s+/).filter(Boolean);
            const action = (words[0] || 'stats').toLowerCase();

            if (action === 'forget') {
                const id = words[1];
                if (!id) return message.reply('Give me the track id to forget — `/tags list` shows them.');
                const gone = sidecar.forget(id);
                return message.reply(gone
                    ? `🗑️ Forgot the inferred tags for track \`${id}\`.`
                    : `Nothing stored for track \`${id}\`.`);
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
            const embed = new EmbedBuilder()
                .setColor(0x4169c8)
                .setTitle('🏷️ Inferred tag sidecar')
                .setDescription(
                    `**${s.active}** track${s.active === 1 ? '' : 's'} currently backed by inferred tags` +
                    (s.superseded ? `, **${s.superseded}** retired since Plex supplied real data` : '') + '.\n\n' +
                    `**${s.moods}** moods · **${s.genres}** genres · **${s.styles}** styles\n\n` +
                    'Nothing here is written to Plex — it is a local layer consulted only where Plex has nothing.'
                )
                .setFooter({ text: s.file });
            return message.channel.send({ embeds: [embed] });
        }
    }
};
