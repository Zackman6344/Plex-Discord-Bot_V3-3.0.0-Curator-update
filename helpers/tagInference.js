// helpers/tagInference.js
//
// Proposes tags for tracks Plex has no metadata for, and drives the per-track review a human
// walks before anything is written. Three rules shape the inference:
//
//   - Only dimensions Plex is actually missing get filled. Real agent data is never
//     second-guessed, so an inferred tag can only ever fill a gap.
//   - Tags must come from the library's own vocabulary, for the same reason /vibe constrains its
//     search: an invented tag matches nothing and is worse than no tag at all.
//   - Anything the user has already said about a track is fed back in, so a correction only has
//     to be made once.
//
// The card is the only path to writing, so it is defensive throughout: every Discord limit is
// enforced before sending, every click is answered through a fallback chain, and a failed disk
// write leaves the decision undone rather than silently lost.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { getModel } = require('./geminiAPI.js');
const { getPlex } = require('./plexClient.js');
const plexTags = require('./plexTags.js');
const logger = require('./logger.js');
const sidecar = require('./tagSidecar.js');

const NAMESPACE = 'tagprop';
const MAX_TRACKS_PER_RUN = 25;
const MODAL_TIMEOUT_MS = 5 * 60 * 1000;

// Discord's documented ceilings. Exceeding any of them rejects the whole message, which for a
// review card means the user silently loses the chance to approve.
const LIMIT = { title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, embedTotal: 5800 };

const clamp = (str, max) => {
    const text = String(str == null ? '' : str);
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
};

const tagLine = (entry) => {
    const parts = [];
    if (entry.moods && entry.moods.length) parts.push(`**moods:** ${entry.moods.join(', ')}`);
    if (entry.genres && entry.genres.length) parts.push(`**genres:** ${entry.genres.join(', ')}`);
    if (entry.styles && entry.styles.length) parts.push(`**styles:** ${entry.styles.join(', ')}`);
    return parts.join('\n') || '_no confident suggestion_';
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

function vocabLists(vocab) {
    return {
        moods: ((vocab && vocab.moods) || []).map((m) => m.title),
        genres: ((vocab && vocab.genres) || []).map((g) => g.title),
        styles: ((vocab && vocab.styles) || []).map((s) => s.title)
    };
}

/** Drop anything outside the vocabulary or outside the dimensions Plex is missing. */
function cleanSuggestion(row, missing, lists) {
    const pick = (dim, list, vocabList) => {
        if (!missing.includes(dim)) return [];
        const allowed = new Set(vocabList.map((v) => String(v).toLowerCase()));
        return [...new Set((Array.isArray(list) ? list : []).filter((t) => allowed.has(String(t).toLowerCase())))];
    };
    return {
        moods: pick('moods', row && row.moods, lists.moods),
        genres: pick('genres', row && row.genres, lists.genres),
        styles: pick('styles', row && row.styles, lists.styles)
    };
}

/**
 * Build proposals for whichever of `ratingKeys` are missing tags.
 * @returns {Promise<{proposals: Array, superseded: number, examined: number}>}
 */
async function proposeForTracks(ratingKeys, vocab) {
    const tracks = await fetchFullTracks(ratingKeys);
    const needy = [];
    let superseded = 0;

    for (const track of tracks) {
        const missing = sidecar.missingDimensions(track);
        const existing = sidecar.get(track.ratingKey);

        if (existing && !existing.supersededAt && missing.length < sidecar.DIMENSIONS.length) {
            if (sidecar.supersede(track.ratingKey)) superseded++;
        }
        if (missing.length === 0) continue;
        if (existing && !existing.supersededAt) continue;
        needy.push({ track, missing });
    }

    if (needy.length === 0) return { proposals: [], superseded, examined: tracks.length };

    const lists = vocabLists(vocab);
    if (!lists.moods.length && !lists.genres.length && !lists.styles.length) {
        logger.warn('tagInference: no tag vocabulary available — skipping inference.');
        return { proposals: [], superseded, examined: tracks.length };
    }

    const payload = needy.map((n, i) => {
        const past = sidecar.getFeedback(n.track.ratingKey);
        return {
            i,
            title: n.track.title,
            artist: n.track.originalTitle || n.track.grandparentTitle || null,
            album: n.track.parentTitle || null,
            year: n.track.parentYear || null,
            knownGenres: (n.track.Genre || []).map((g) => g.tag),
            needs: n.missing,
            // A correction the user already made about this track, so it isn't repeated.
            userSaidPreviously: past && past.text ? past.text : undefined
        };
    });

    const prompt = `
You are tagging tracks in a music library that is missing metadata for them.

For each track below, supply ONLY the dimensions listed in its "needs" array. Leave any other
dimension as an empty array — the library already has real data there and it must not be touched.

Choose tags ONLY from these lists, copying the names exactly. Never invent a tag.
MOODS: ${JSON.stringify(lists.moods)}
GENRES: ${JSON.stringify(lists.genres)}
STYLES: ${JSON.stringify(lists.styles)}

Where a track has "userSaidPreviously", that is the library owner correcting an earlier attempt.
Treat it as authoritative and do not repeat the mistake.

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
        const tags = cleanSuggestion(row, target.missing, lists);
        if (!tags.moods.length && !tags.genres.length && !tags.styles.length) continue;

        proposals.push({
            ratingKey: target.track.ratingKey,
            title: target.track.title,
            artist: target.track.originalTitle || target.track.grandparentTitle || 'Unknown Artist',
            album: target.track.parentTitle || null,
            file: filePathOf(target.track),
            missing: target.missing,
            ...tags,
            source: 'gemini'
        });
    }

    return { proposals, superseded, examined: tracks.length };
}

/**
 * Re-run inference for one track, told what the user thought of the last attempt.
 * @returns {Promise<{ok: boolean, tags?: Object, reason?: string}>}
 */
async function regenerateForTrack(entry, feedbackText) {
    try {
        const vocab = await plexTags.getVocabulary();
        const lists = vocabLists(vocab);
        const missing = Array.isArray(entry.missing) && entry.missing.length ? entry.missing : sidecar.DIMENSIONS;

        const prompt = `
You previously suggested tags for this track and the library owner was not satisfied.

TRACK: ${JSON.stringify({ title: entry.title, artist: entry.artist, album: entry.album })}
YOUR PREVIOUS SUGGESTION: ${JSON.stringify({ moods: entry.moods, genres: entry.genres, styles: entry.styles })}
WHAT THE OWNER SAYS: ${JSON.stringify(feedbackText || 'The previous tags were wrong.')}

Their judgement is authoritative — they know this library and this track. Revise accordingly
rather than defending the previous answer.

Fill ONLY these dimensions: ${JSON.stringify(missing)}. Leave the others as empty arrays.
Choose ONLY from these lists, copying names exactly. Never invent a tag.
MOODS: ${JSON.stringify(lists.moods)}
GENRES: ${JSON.stringify(lists.genres)}
STYLES: ${JSON.stringify(lists.styles)}

Output ONLY a raw JSON object exactly like this:
{"moods":["Energetic"],"genres":[],"styles":[]}
`;

        const result = await getModel().generateContent(prompt);
        const text = result && result.response ? result.response.text() : '';
        const match = String(text).match(/\{[\s\S]*\}/);
        if (!match) return { ok: false, reason: 'the AI returned nothing usable' };

        const tags = cleanSuggestion(JSON.parse(match[0]), missing, lists);
        if (!tags.moods.length && !tags.genres.length && !tags.styles.length) {
            return { ok: false, reason: 'the AI had no confident suggestion this time' };
        }
        return { ok: true, tags };
    } catch (err) {
        logger.error('tagInference: regeneration failed:', err.message || err);
        return { ok: false, reason: 'the AI call failed — check the bot log' };
    }
}

/**
 * The review card for one track. Each song is decided on its own, so a bad suggestion can be
 * rejected without dragging down the good ones alongside it.
 */
function buildReviewCard(proposalId, proposal, index) {
    const entries = (proposal && proposal.entries) || [];
    if (!proposalId || entries.length === 0) {
        return { content: '🏷️ Nothing to propose — Plex already has metadata for these tracks.', embeds: [], components: [] };
    }

    const counts = entries.reduce((acc, e) => {
        acc[e.status === 'approved' ? 'approved' : e.status === 'rejected' ? 'rejected' : 'pending']++;
        return acc;
    }, { approved: 0, rejected: 0, pending: 0 });

    if (counts.pending === 0) {
        return {
            content: `🏷️ Review complete — **${counts.approved}** saved, **${counts.rejected}** rejected. ` +
                     'Run `/tags list` to see what was stored.',
            embeds: [],
            components: []
        };
    }

    const i = Math.max(0, Math.min(index || 0, entries.length - 1));
    const entry = entries[i];
    const state = entry.status === 'approved' ? '✅ saved'
        : entry.status === 'rejected' ? '❌ rejected'
        : '⏳ undecided';

    const embed = new EmbedBuilder()
        .setColor(entry.status === 'approved' ? 0x4caf50 : entry.status === 'rejected' ? 0x9e9e9e : 0x4169c8)
        .setTitle(clamp(`🏷️ ${entry.title || 'Unknown title'}`, LIMIT.title))
        .setDescription(clamp(
            `by **${entry.artist || 'Unknown artist'}**${entry.album ? ` · _${entry.album}_` : ''}\n\n` +
            `${tagLine(entry)}\n\n` +
            (entry.feedback ? `_You said:_ ${clamp(entry.feedback, 300)}\n\n` : '') +
            'Plex has no metadata for this track, so these are **inferred guesses**. ' +
            'Nothing is written until you approve it.',
            LIMIT.description
        ))
        .setFooter({ text: clamp(
            `Track ${i + 1} of ${entries.length} · ${state} · ${counts.approved} saved, ${counts.rejected} rejected, ${counts.pending} to go`,
            2000
        ) });

    const decide = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${NAMESPACE}:approve:${proposalId}:${i}`)
            .setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(entry.status === 'approved'),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:reject:${proposalId}:${i}`)
            .setLabel('Reject').setStyle(ButtonStyle.Danger).setDisabled(entry.status === 'rejected'),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:feedback:${proposalId}:${i}`)
            .setLabel('Tell it why & retry').setStyle(ButtonStyle.Primary)
    );

    const navigate = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${NAMESPACE}:prev:${proposalId}:${i}`)
            .setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(entries.length < 2),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:next:${proposalId}:${i}`)
            .setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(entries.length < 2),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:approveall:${proposalId}:${i}`)
            .setLabel(`Approve remaining (${counts.pending})`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${NAMESPACE}:done:${proposalId}:${i}`)
            .setLabel('Finish').setStyle(ButtonStyle.Secondary)
    );

    return { content: '', embeds: [embed], components: [decide, navigate] };
}

/** Index of the next track still awaiting a decision, or the current one if none remain. */
function nextPending(entries, from) {
    for (let step = 1; step <= entries.length; step++) {
        const idx = (from + step) % entries.length;
        if (entries[idx].status === 'pending') return idx;
    }
    return from;
}

/**
 * Answer a click exactly once, trying progressively weaker channels. A review card that silently
 * does nothing is the worst outcome: the user can't tell whether their tags were saved.
 */
async function respond(interaction, payload, { asUpdate = true } = {}) {
    const message = typeof payload === 'string' ? { content: payload, embeds: [], components: [] } : payload;

    try {
        if (asUpdate && typeof interaction.update === 'function') {
            await interaction.update(message);
            return true;
        }
    } catch (err) {
        logger.warn('tagInference: update failed, falling back:', err.message || err);
    }

    const content = message.content || 'Done.';
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
        logger.error('tagInference: could not deliver a response to the click:', err.message || err);
    }
    return false;
}

/** Feedback modal → regenerate that one track → refresh the card in place. */
async function runFeedbackFlow(interaction, id, index, entry) {
    const modalId = `${NAMESPACE}_modal_${id}_${index}`;
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(clamp(`Retag: ${entry.title || 'this track'}`, 45))
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('tagfb_text')
                .setLabel('What did it get wrong?')
                .setPlaceholder('e.g. this is a sea shanty, not synthwave — and it is not upbeat')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(500)
                .setRequired(true)
        ));

    try {
        await interaction.showModal(modal);
    } catch (err) {
        logger.warn('tagInference: could not open the feedback modal:', err.message || err);
        await respond(interaction, '❌ Could not open the feedback box — nothing changed.', { asUpdate: false });
        return;
    }

    let submitted;
    try {
        submitted = await interaction.awaitModalSubmit({
            time: MODAL_TIMEOUT_MS,
            filter: (m) => m.customId === modalId && m.user.id === interaction.user.id
        });
    } catch (_) {
        // Timed out or dismissed. The card is untouched and still usable, so keep this quiet.
        try {
            await interaction.followUp({ content: '⌛ Feedback box closed — the track is unchanged.', ephemeral: true });
        } catch (__) { /* the card itself is still live */ }
        return;
    }

    const note = (submitted.fields.getTextInputValue('tagfb_text') || '').trim();

    try {
        await submitted.deferUpdate();
    } catch (err) {
        logger.warn('tagInference: could not defer the modal submit:', err.message || err);
    }

    const result = await regenerateForTrack(entry, note);
    sidecar.recordFeedback(entry.ratingKey, note, submitted.user.id, 'revised');

    if (!result.ok) {
        // Keep the note even when the retry fails — it still improves the next run.
        sidecar.updateProposalEntry(id, index, { feedback: note });
        const card = buildReviewCard(id, sidecar.getProposal(id), index);
        card.content = `⚠️ Kept the previous suggestion — ${result.reason}. Your note was saved.`;
        try {
            await submitted.editReply(card);
        } catch (_) {
            await respond(submitted, card.content, { asUpdate: false });
        }
        return;
    }

    sidecar.updateProposalEntry(id, index, { ...result.tags, feedback: note });
    const card = buildReviewCard(id, sidecar.getProposal(id), index);
    card.content = '🔄 Regenerated with your note in mind.';
    try {
        await submitted.editReply(card);
    } catch (err) {
        logger.warn('tagInference: could not refresh the card after regeneration:', err.message || err);
        await respond(submitted, '🔄 Regenerated — reopen the card to see the new suggestion.', { asUpdate: false });
    }
}

/**
 * Button handler for the review card, following the playbackButtons contract.
 * Never throws: an exception here would surface to the user as a dead button.
 *
 * @returns {Promise<boolean>} true if the customId belonged to this module
 */
async function handle(interaction) {
    try {
        if (!interaction || typeof interaction.customId !== 'string') return false;
        const [namespace, action, id, rawIndex] = interaction.customId.split(':');
        if (namespace !== NAMESPACE) return false;

        if (!id) {
            await respond(interaction, '❌ That button is malformed — nothing was written.', { asUpdate: false });
            return true;
        }

        const proposal = sidecar.getProposal(id);
        if (!proposal) {
            await respond(interaction, '⌛ That review has expired or was already finished — nothing was written.');
            return true;
        }

        const clicker = interaction.user && interaction.user.id;
        if (proposal.requesterId && clicker && clicker !== proposal.requesterId) {
            await respond(interaction, 'Only the person who ran the command can review these tags.', { asUpdate: false });
            return true;
        }

        const entries = proposal.entries;
        const index = Math.max(0, Math.min(parseInt(rawIndex, 10) || 0, entries.length - 1));
        const entry = entries[index];

        // Cards from before the per-track review shipped used `tagprop:approve:<id>` with no
        // index, plus a `discard` action. Keep them working rather than stranding a live card.
        if (rawIndex === undefined) {
            if (action === 'discard') {
                sidecar.discard(id);
                await respond(interaction, '🗑️ Discarded — nothing was written.');
                return true;
            }
            if (action === 'approve') {
                const { written, saved } = sidecar.approveRemaining(id, clicker || null);
                await respond(interaction, saved
                    ? `✅ Saved tags for **${written}** track${written === 1 ? '' : 's'}.`
                    : '❌ Could not write the sidecar file, so **nothing was saved**. Check the bot log — the card is still live, so you can try again once it is fixed.');
                return true;
            }
        }

        switch (action) {
            case 'prev':
            case 'next': {
                const step = action === 'next' ? 1 : -1;
                const moved = (index + step + entries.length) % entries.length;
                await respond(interaction, buildReviewCard(id, proposal, moved));
                return true;
            }

            case 'approve': {
                const result = sidecar.approveOne(id, index, clicker || null);
                if (!result.ok) {
                    await respond(interaction, result.reason === 'write-failed'
                        ? '❌ Could not write the sidecar file, so **this track was not saved**. Check the bot log — the button still works once it is fixed.'
                        : '⌛ That track is no longer part of an active review.', { asUpdate: false });
                    return true;
                }
                const refreshed = sidecar.getProposal(id);
                await respond(interaction, buildReviewCard(id, refreshed, nextPending(refreshed.entries, index)));
                return true;
            }

            case 'reject': {
                const result = sidecar.rejectOne(id, index, clicker || null, null);
                if (!result.ok) {
                    await respond(interaction, '⌛ That track is no longer part of an active review.', { asUpdate: false });
                    return true;
                }
                const refreshed = sidecar.getProposal(id);
                await respond(interaction, buildReviewCard(id, refreshed, nextPending(refreshed.entries, index)));
                return true;
            }

            case 'feedback':
                await runFeedbackFlow(interaction, id, index, entry);
                return true;

            case 'approveall': {
                const { written, saved } = sidecar.approveRemaining(id, clicker || null);
                if (!saved) {
                    await respond(
                        interaction,
                        '❌ Could not write the sidecar file, so **nothing was saved**. Check the bot log — the card is still live, so you can try again.',
                        { asUpdate: false }
                    );
                    return true;
                }
                const card = buildReviewCard(id, sidecar.getProposal(id), index);
                card.content = `✅ Saved **${written}** remaining track${written === 1 ? '' : 's'}.`;
                await respond(interaction, card);
                return true;
            }

            case 'done': {
                const counts = sidecar.proposalSummary(id) || { approved: 0, rejected: 0, pending: 0 };
                sidecar.discard(id);
                await respond(interaction,
                    `🏁 Review closed — **${counts.approved}** saved, **${counts.rejected}** rejected` +
                    (counts.pending ? `, **${counts.pending}** left undecided (not written).` : '.'));
                return true;
            }

            default:
                await respond(interaction, '❌ Unknown action on that card — nothing was written.', { asUpdate: false });
                return true;
        }
    } catch (err) {
        logger.error('tagInference: review handler threw:', err);
        try {
            await respond(interaction, '❌ Something went wrong handling that click — nothing was written. Check the bot log.', { asUpdate: false });
        } catch (_) { /* already logged */ }
        return true;
    }
}

/** Entry point used by /vibe: renders the first card of a fresh review. */
function buildApprovalMessage(proposalId, proposals) {
    const entries = (proposals || []).map((p) => ({ status: 'pending', ...p }));
    return buildReviewCard(proposalId, { entries }, 0);
}

module.exports = {
    proposeForTracks, regenerateForTrack, buildReviewCard, buildApprovalMessage,
    handle, respond, filePathOf, nextPending,
    NAMESPACE, MAX_TRACKS_PER_RUN, MODAL_TIMEOUT_MS, LIMIT
};
