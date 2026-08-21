// helpers/tagInference.js
//
// Proposes tags for tracks Plex has no metadata for, and renders the approval card a human must
// click before anything is written. Two rules shape the prompt:
//
//   - Only dimensions Plex is actually missing get inferred. Real agent data is never
//     second-guessed, so an inferred tag can only ever fill a gap.
//   - Tags must come from the library's own vocabulary, for the same reason /vibe constrains its
//     search: an invented tag matches nothing and is worse than no tag at all.
//
// The card is the only path to writing, so it is written defensively throughout: every Discord
// limit is enforced before sending, the handler always answers the click through a fallback
// chain, and a failed disk write leaves the proposal intact so the button still works.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getModel } = require('./geminiAPI.js');
const { getPlex } = require('./plexClient.js');
const logger = require('./logger.js');
const sidecar = require('./tagSidecar.js');

const NAMESPACE = 'tagprop';
const MAX_TRACKS_PER_RUN = 25;

// Discord's documented ceilings. Exceeding any of them rejects the whole message, which for a
// review card means the user silently loses the chance to approve.
const LIMIT = { title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, embedTotal: 5800 };

const clamp = (str, max) => {
    const text = String(str == null ? '' : str);
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
};

/**
 * Fetch full metadata for the given rating keys. Section listings omit Mood and Style entirely,
 * so a per-track fetch is the only way to know what a track is really missing.
 */
async function fetchFullTracks(ratingKeys) {
    const plex = getPlex();
    const out = [];
    for (const rk of (ratingKeys || []).slice(0, MAX_TRACKS_PER_RUN)) {
        try {
            const res = await plex.query(`/library/metadata/${rk}`);
            const track = res && res.MediaContainer && res.MediaContainer.Metadata && res.MediaContainer.Metadata[0];
            if (track) out.push(track);
        } catch (err) {
            logger.warn(`tagInference: could not fetch track ${rk}:`, err.message || err);
        }
    }
    return out;
}

/** The on-disk path, when Plex exposes it — the handle external tagging tools actually use. */
function filePathOf(track) {
    try {
        return track.Media[0].Part[0].file || null;
    } catch (_) {
        return null;
    }
}

/**
 * Build proposals for whichever of `ratingKeys` are missing tags. Returns an empty proposal list
 * when Plex already covers everything, which is the common case for tag-search results.
 *
 * @returns {Promise<{proposals: Array, superseded: number, examined: number}>}
 */
async function proposeForTracks(ratingKeys, vocab) {
    const tracks = await fetchFullTracks(ratingKeys);
    const needy = [];
    let superseded = 0;

    for (const track of tracks) {
        const missing = sidecar.missingDimensions(track);
        const existing = sidecar.get(track.ratingKey);

        // Plex has since filled in something we once guessed — retire the guess.
        if (existing && !existing.supersededAt && missing.length < sidecar.DIMENSIONS.length) {
            if (sidecar.supersede(track.ratingKey)) superseded++;
        }
        if (missing.length === 0) continue;
        if (existing && !existing.supersededAt) continue; // already approved for this track
        needy.push({ track, missing });
    }

    if (needy.length === 0) return { proposals: [], superseded, examined: tracks.length };

    const moodVocab = ((vocab && vocab.moods) || []).map((m) => m.title);
    const genreVocab = ((vocab && vocab.genres) || []).map((g) => g.title);
    const styleVocab = ((vocab && vocab.styles) || []).map((s) => s.title);

    if (!moodVocab.length && !genreVocab.length && !styleVocab.length) {
        logger.warn('tagInference: no tag vocabulary available — skipping inference.');
        return { proposals: [], superseded, examined: tracks.length };
    }

    const payload = needy.map((n, i) => ({
        i,
        title: n.track.title,
        artist: n.track.originalTitle || n.track.grandparentTitle || null,
        album: n.track.parentTitle || null,
        year: n.track.parentYear || null,
        knownGenres: (n.track.Genre || []).map((g) => g.tag),
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

    const result = await getModel().generateContent(prompt);
    const text = result && result.response ? result.response.text() : '';
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Tag inference returned no JSON');

    const parsed = JSON.parse(match[0]);
    const rows = Array.isArray(parsed && parsed.tracks) ? parsed.tracks : [];
    const proposals = [];

    for (const row of rows) {
        const target = needy[row && row.i];
        if (!target) continue;
        // Belt and braces: drop anything for a dimension Plex already covers, and anything that
        // isn't in the vocabulary, even though the prompt forbids both.
        const clean = (dim, list, vocabList) => {
            if (!target.missing.includes(dim)) return [];
            const allowed = new Set(vocabList.map((v) => String(v).toLowerCase()));
            return [...new Set((Array.isArray(list) ? list : []).filter((t) => allowed.has(String(t).toLowerCase())))];
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
            file: filePathOf(target.track),
            moods, genres, styles,
            source: 'gemini'
        });
    }

    return { proposals, superseded, examined: tracks.length };
}

/**
 * The review card: every proposed tag is visible before anything is written. Built inside the
 * Discord limits — a card that Discord rejects is a card the user can never approve.
 */
function buildApprovalMessage(proposalId, proposals) {
    const list = Array.isArray(proposals) ? proposals : [];
    if (!proposalId || list.length === 0) {
        return { content: '🏷️ Nothing to propose — Plex already has metadata for these tracks.' };
    }

    const intro =
        'Plex has no metadata for these, so these tags are **inferred guesses**. ' +
        'Nothing is written until you approve. If Plex later supplies real data for a track, ' +
        'that always wins and the guess is retired.';

    const embed = new EmbedBuilder()
        .setColor(0x4169c8)
        .setTitle(clamp(`🏷️ Proposed tags for ${list.length} track${list.length === 1 ? '' : 's'}`, LIMIT.title))
        .setDescription(clamp(intro, LIMIT.description));

    let budget = LIMIT.embedTotal - intro.length - 64;
    let shown = 0;

    for (const p of list) {
        if (shown >= LIMIT.fields) break;
        try {
            const parts = [];
            if (p.moods && p.moods.length) parts.push(`**moods:** ${p.moods.join(', ')}`);
            if (p.genres && p.genres.length) parts.push(`**genres:** ${p.genres.join(', ')}`);
            if (p.styles && p.styles.length) parts.push(`**styles:** ${p.styles.join(', ')}`);

            const name = clamp(`${p.title || 'Unknown title'} — ${p.artist || 'Unknown artist'}`, LIMIT.fieldName);
            const value = clamp(parts.join('\n') || '_nothing confident_', LIMIT.fieldValue);
            if (name.length + value.length > budget) break;

            embed.addFields({ name, value });
            budget -= name.length + value.length;
            shown++;
        } catch (err) {
            logger.warn('tagInference: skipped an unrenderable proposal:', err.message || err);
        }
    }

    if (shown < list.length) {
        embed.setFooter({
            text: clamp(`+${list.length - shown} more will be saved too — full detail in data/inferred_tags.json after approval.`, 2000)
        });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${NAMESPACE}:approve:${proposalId}`).setLabel('Approve & save').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:discard:${proposalId}`).setLabel('Discard').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
}

/**
 * Answer a button click exactly once, trying progressively weaker channels. A review card that
 * silently does nothing is the worst outcome here: the user can't tell whether their tags were
 * saved, so every branch below ends in *some* visible response.
 *
 * @param {boolean} clearCard - whether to strip the embed/buttons from the original message
 */
async function respond(interaction, content, clearCard) {
    const payload = clearCard ? { content, embeds: [], components: [] } : { content };

    try {
        if (clearCard && typeof interaction.update === 'function') {
            await interaction.update(payload);
            return true;
        }
    } catch (err) {
        logger.warn('tagInference: update failed, falling back:', err.message || err);
    }

    try {
        if (typeof interaction.reply === 'function' && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content, ephemeral: true });
            return true;
        }
    } catch (err) {
        logger.warn('tagInference: reply failed, falling back:', err.message || err);
    }

    try {
        if (typeof interaction.followUp === 'function') {
            await interaction.followUp({ content, ephemeral: true });
            return true;
        }
    } catch (err) {
        logger.warn('tagInference: followUp failed, falling back:', err.message || err);
    }

    try {
        if (interaction.channel && typeof interaction.channel.send === 'function') {
            await interaction.channel.send(content);
            return true;
        }
    } catch (err) {
        logger.error('tagInference: could not deliver a response to the approval click:', err.message || err);
    }
    return false;
}

/**
 * Button handler for the approval card, following the playbackButtons contract.
 * Never throws: an exception here would surface to the user as a dead button.
 *
 * @returns {Promise<boolean>} true if the customId belonged to this module
 */
async function handle(interaction) {
    try {
        if (!interaction || typeof interaction.customId !== 'string') return false;
        const [namespace, action, id] = interaction.customId.split(':');
        if (namespace !== NAMESPACE) return false;

        if (!id) {
            await respond(interaction, '❌ That button is malformed — nothing was written.', false);
            return true;
        }

        const proposal = sidecar.getProposal(id);
        if (!proposal) {
            await respond(interaction, '⌛ That proposal has expired or was already handled — nothing was written.', true);
            return true;
        }

        // Only whoever ran the command decides — a review step anyone can click isn't a review step.
        const clicker = interaction.user && interaction.user.id;
        if (proposal.requesterId && clicker && clicker !== proposal.requesterId) {
            await respond(interaction, 'Only the person who ran the command can approve these tags.', false);
            return true;
        }

        if (action === 'discard') {
            sidecar.discard(id);
            await respond(interaction, '🗑️ Discarded — nothing was written.', true);
            return true;
        }

        if (action !== 'approve') {
            await respond(interaction, '❌ Unknown action on that card — nothing was written.', false);
            return true;
        }

        const { written, saved, reason } = sidecar.approve(id, clicker || null);

        if (saved) {
            await respond(
                interaction,
                `✅ Saved tags for **${written}** track${written === 1 ? '' : 's'} to the local sidecar. ` +
                'Plex is untouched — run `/tags list` to review or `/tags forget` to undo.',
                true
            );
            return true;
        }

        if (reason === 'nothing-valid') {
            await respond(interaction, '❌ None of those proposals were usable, so nothing was written.', true);
        } else if (reason === 'expired') {
            await respond(interaction, '⌛ That proposal expired before it could be saved — nothing was written.', true);
        } else {
            // The proposal is deliberately still live here, so the same button can be retried.
            await respond(
                interaction,
                '❌ Could not write the sidecar file, so **nothing was saved**. Check the bot log (disk full or permissions?) — ' +
                'the card is still live, so you can press Approve again once it is fixed.',
                false
            );
        }
        return true;
    } catch (err) {
        logger.error('tagInference: approval handler threw:', err);
        try {
            await respond(interaction, '❌ Something went wrong handling that click — nothing was written. Check the bot log.', false);
        } catch (_) { /* already logged */ }
        return true;
    }
}

module.exports = { proposeForTracks, buildApprovalMessage, handle, respond, filePathOf, NAMESPACE, MAX_TRACKS_PER_RUN, LIMIT };
