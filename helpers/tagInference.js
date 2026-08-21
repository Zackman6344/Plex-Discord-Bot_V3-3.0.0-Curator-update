// helpers/tagInference.js
//
// Proposes tags for tracks Plex has no metadata for, and renders the approval card a human has
// to click before anything is written. Two rules shape the prompt:
//
//   - Only dimensions Plex is actually missing get inferred. Real agent data is never
//     second-guessed, so an inferred tag can only ever fill a gap.
//   - Tags must come from the library's own vocabulary, for the same reason /vibe constrains
//     its search: an invented tag matches nothing and is worse than no tag at all.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getModel } = require('./geminiAPI.js');
const { getPlex } = require('./plexClient.js');
const logger = require('./logger.js');
const sidecar = require('./tagSidecar.js');

const NAMESPACE = 'tagprop';
const MAX_TRACKS_PER_RUN = 25;

/**
 * Fetch full metadata for the given rating keys. Section listings omit Mood and Style entirely,
 * so a per-track fetch is the only way to know what a track is really missing.
 */
async function fetchFullTracks(ratingKeys) {
    const plex = getPlex();
    const out = [];
    for (const rk of ratingKeys.slice(0, MAX_TRACKS_PER_RUN)) {
        try {
            const res = await plex.query(`/library/metadata/${rk}`);
            const track = res.MediaContainer && res.MediaContainer.Metadata && res.MediaContainer.Metadata[0];
            if (track) out.push(track);
        } catch (err) {
            logger.warn(`tagInference: could not fetch track ${rk}:`, err.message || err);
        }
    }
    return out;
}

/**
 * Build proposals for whichever of `ratingKeys` are missing tags. Returns [] when Plex already
 * covers everything, which is the common case for tracks found via a tag search.
 *
 * @returns {Promise<{proposals: Array, superseded: number, examined: number}>}
 */
async function proposeForTracks(ratingKeys, vocab) {
    const tracks = await fetchFullTracks(ratingKeys);
    const needy = [];
    let superseded = 0;

    for (const track of tracks) {
        const missing = sidecar.missingDimensions(track);
        // Plex has since filled in what we once guessed — retire the guess.
        const existing = sidecar.get(track.ratingKey);
        if (existing && !existing.supersededAt && missing.length < sidecar.DIMENSIONS.length) {
            const nowOfficial = sidecar.DIMENSIONS.filter((d) => !missing.includes(d));
            if (nowOfficial.length && sidecar.supersede(track.ratingKey)) superseded++;
        }
        if (missing.length === 0) continue;
        if (existing && !existing.supersededAt) continue; // already proposed and approved
        needy.push({ track, missing });
    }

    if (needy.length === 0) return { proposals: [], superseded, examined: tracks.length };

    const moodVocab = (vocab.moods || []).map((m) => m.title);
    const genreVocab = (vocab.genres || []).map((g) => g.title);
    const styleVocab = (vocab.styles || []).map((s) => s.title);

    const payload = needy.map((n, i) => ({
        i,
        title: n.track.title,
        artist: n.track.originalTitle || n.track.grandparentTitle || null,
        album: n.track.parentTitle || null,
        year: n.track.parentYear || null,
        knownGenres: ((n.track.Genre || []).map((g) => g.tag)),
        needs: n.missing
    }));

    const prompt = `
You are tagging tracks in a music library that is missing metadata for them.

For each track below, supply ONLY the dimensions listed in its "needs" array. Leave any other
dimension as an empty array — the library already has real data there and it must not be touched.

Choose tags ONLY from these lists, copying the names exactly. Never invent a tag.
MOODS: ${JSON.stringify(moodVocab)}
GENRES: ${JSON.stringify(genreVocab)}
STYLES: ${JSON.stringify(styleVocab)}

Include every tag that genuinely applies — breadth is useful — but do not pad with tags you are
not reasonably confident about. If you don't recognise a track well enough to tag it, return
empty arrays for it rather than guessing wildly.

TRACKS:
${JSON.stringify(payload)}

Output ONLY a raw JSON object exactly like this:
{"tracks":[{"i":0,"moods":["Energetic"],"genres":[],"styles":[]}]}
`;

    const model = getModel();
    const result = await model.generateContent(prompt);
    const match = result.response.text().match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Tag inference returned no JSON');

    const parsed = JSON.parse(match[0]);
    const proposals = [];

    for (const row of parsed.tracks || []) {
        const target = needy[row.i];
        if (!target) continue;
        // Belt and braces: drop anything for a dimension Plex already covers, and anything that
        // isn't in the vocabulary, even though the prompt forbids both.
        const clean = (dim, list, vocabList) => {
            if (!target.missing.includes(dim)) return [];
            const allowed = new Set(vocabList.map((v) => v.toLowerCase()));
            return [...new Set((list || []).filter((t) => allowed.has(String(t).toLowerCase())))];
        };
        const moods = clean('moods', row.moods, moodVocab);
        const genres = clean('genres', row.genres, genreVocab);
        const styles = clean('styles', row.styles, styleVocab);
        if (!moods.length && !genres.length && !styles.length) continue;

        proposals.push({
            ratingKey: target.track.ratingKey,
            title: target.track.title,
            artist: target.track.originalTitle || target.track.grandparentTitle || 'Unknown Artist',
            album: target.track.parentTitle || null,
            moods, genres, styles,
            source: 'gemini'
        });
    }

    return { proposals, superseded, examined: tracks.length };
}

/** The review card: every proposed tag is visible before anything is written. */
function buildApprovalMessage(proposalId, proposals) {
    const embed = new EmbedBuilder()
        .setColor(0x4169c8)
        .setTitle(`🏷️ Proposed tags for ${proposals.length} track${proposals.length === 1 ? '' : 's'}`)
        .setDescription(
            'Plex has no metadata for these, so these tags are **inferred guesses**. ' +
            'Nothing is written until you approve. If Plex later supplies real data for a track, ' +
            'that always wins and the guess is retired.'
        );

    for (const p of proposals.slice(0, 25)) {
        const parts = [];
        if (p.moods.length) parts.push(`**moods:** ${p.moods.join(', ')}`);
        if (p.genres.length) parts.push(`**genres:** ${p.genres.join(', ')}`);
        if (p.styles.length) parts.push(`**styles:** ${p.styles.join(', ')}`);
        embed.addFields({
            name: `${p.title} — ${p.artist}`.slice(0, 256),
            value: (parts.join('\n') || '_nothing confident_').slice(0, 1024)
        });
    }
    if (proposals.length > 25) {
        embed.setFooter({ text: `+${proposals.length - 25} more will be written too — full detail in data/inferred_tags.json after approval.` });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${NAMESPACE}:approve:${proposalId}`).setLabel('Approve & save').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:discard:${proposalId}`).setLabel('Discard').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
}

/**
 * Button handler for the approval card, following the playbackButtons contract.
 *
 * @returns {Promise<boolean>} true if the customId belonged to this module
 */
async function handle(interaction) {
    if (typeof interaction.customId !== 'string') return false;
    const [namespace, action, id] = interaction.customId.split(':');
    if (namespace !== NAMESPACE) return false;

    const proposal = sidecar.getProposal(id);
    if (!proposal) {
        try {
            await interaction.reply({ content: '⌛ That proposal has expired or was already handled.', ephemeral: true });
        } catch (_) {}
        return true;
    }

    // Only whoever ran the command decides — a review step anyone can click isn't a review step.
    if (proposal.requesterId && interaction.user.id !== proposal.requesterId) {
        try {
            await interaction.reply({ content: 'Only the person who ran the command can approve these tags.', ephemeral: true });
        } catch (_) {}
        return true;
    }

    if (action === 'discard') {
        sidecar.discard(id);
        try {
            await interaction.update({ content: '🗑️ Discarded — nothing was written.', embeds: [], components: [] });
        } catch (_) {}
        return true;
    }

    if (action === 'approve') {
        const { written, saved } = sidecar.approve(id, interaction.user.id);
        const text = saved
            ? `✅ Saved tags for **${written}** track${written === 1 ? '' : 's'} to the local sidecar. Plex is untouched; run \`/tags list\` to review.`
            : '❌ Could not write the sidecar file — check the bot log.';
        try {
            await interaction.update({ content: text, embeds: [], components: [] });
        } catch (_) {}
        return true;
    }

    return true;
}

module.exports = { proposeForTracks, buildApprovalMessage, handle, NAMESPACE, MAX_TRACKS_PER_RUN };
