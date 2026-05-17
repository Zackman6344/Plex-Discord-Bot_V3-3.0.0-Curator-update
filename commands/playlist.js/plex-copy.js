// commands/playlist.js/plex-copy.js
//
// Interactive DM wizard for copying a Plex playlist from any managed user account
// into a local bot playlist file (the same .playlist format `!playlist play` uses).
//
// Flow:
//   1. Open DM with the invoker
//   2. Ask which account (list available managed users)
//   3. Ask for PIN if no cached switched-token for this Discord user
//   4. List that account's audio playlists, ask which one
//   5. Walk its tracks via plex.query()
//   6. Ask for local save name (default = slugified Plex name)
//   7. Check for collision, prompt to overwrite if conflict
//   8. Write the .playlist file using the existing on-disk schema
//
// On-disk schema is preserved as-is (French keys: nom/musiques + per-track titre/
// artiste/cle) so the existing !playlist play / print / delete commands keep working.

const fs = require('fs');
const path = require('path');
const plexHome = require('../../helpers/plexHome.js');
const logger = require('../../helpers/logger.js');

const DM_TIMEOUT_MS = 120000; // 2 minutes per prompt — gives time for PIN lookups

async function promptDM(dmChannel, userId, question) {
    await dmChannel.send(question);
    const filter = m => m.author.id === userId;
    const collected = await dmChannel.awaitMessages({ filter, max: 1, time: DM_TIMEOUT_MS });
    if (collected.size === 0) return null;
    const reply = collected.first().content.trim();
    if (['cancel', 'abort', 'stop', 'quit'].includes(reply.toLowerCase())) return null;
    return reply;
}

function slugifyName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 60) || 'playlist';
}

// Map a Plex track item to the on-disk track shape used by the rest of the playlist code.
// Keeps the legacy French keys for backward compat with existing .playlist files.
function plexTrackToOnDisk(track) {
    const partKey = track.Media && track.Media[0] && track.Media[0].Part && track.Media[0].Part[0] && track.Media[0].Part[0].key;
    const artist = ('originalTitle' in track && track.originalTitle) || track.grandparentTitle || 'Unknown Artist';
    return {
        artiste: artist,
        titre: track.title || 'Unknown Title',
        cle: partKey || ''
    };
}

module.exports = {
    name: 'plex-copy',
    command: {
        usage: '',
        description: 'Interactively copy a Plex playlist from any managed user account into a local bot playlist.',
        process: async function(bot, client, message, args) {
            // Bail early if homeOwnerToken isn't configured — the whole feature depends on it.
            const plexConfig = require('../../config/plex.js');
            if (!plexConfig.homeOwnerToken) {
                return message.reply(
                    '⚠️ `!playlist plex-copy` needs `homeOwnerToken` set in `config/plex.js` ' +
                    '(the Plex Home owner token, used to switch into other managed-user accounts).'
                );
            }

            let dmChannel;
            try {
                dmChannel = await message.author.createDM();
            } catch (err) {
                return message.reply('❌ I could not DM you. Check your privacy settings and try again.');
            }
            await message.channel.send(`📬 <@${message.author.id}>, check your DMs — I'll walk you through copying a Plex playlist.`);

            try {
                // STEP 1: which account?
                let users;
                try {
                    users = await plexHome.listHomeUsers();
                } catch (err) {
                    await dmChannel.send(`❌ Could not list Plex Home users: ${err.message || err}`);
                    return;
                }
                if (!users.length) {
                    await dmChannel.send('❌ Plex returned no Home users. Is Plex Home enabled on your account?');
                    return;
                }
                const userList = users.map(u => `\`${u.username}\`${u.hasPin ? ' 🔒' : ''}${u.admin ? ' (admin)' : ''}`).join(', ');
                const accountReply = await promptDM(
                    dmChannel,
                    message.author.id,
                    `🎵 **Copy a Plex playlist**\n\nWhich account's playlist do you want to copy?\nAvailable: ${userList}\n*(Type \`cancel\` to abort.)*`
                );
                if (!accountReply) return dmChannel.send('🕰️ Cancelled.');

                const targetUser = users.find(u =>
                    u.username.toLowerCase() === accountReply.toLowerCase() ||
                    u.title.toLowerCase() === accountReply.toLowerCase()
                );
                if (!targetUser) {
                    return dmChannel.send(`❌ No managed user named "${accountReply}". Cancelled.`);
                }

                // STEP 2: get a switched client (cache hit → skip PIN; otherwise prompt)
                let plex = plexHome.getCachedClient(message.author.id, targetUser.username);
                if (!plex) {
                    const pinReply = await promptDM(
                        dmChannel,
                        message.author.id,
                        `🔑 Enter the PIN for **${targetUser.username}**.\n*(Type \`cancel\` to abort.)*`
                    );
                    if (pinReply === null) return dmChannel.send('🕰️ Cancelled.');
                    try {
                        plex = await plexHome.switchAs(targetUser.username, pinReply, message.author.id);
                    } catch (err) {
                        return dmChannel.send(`❌ ${err.message || err}`);
                    }
                }

                // STEP 3: list that account's audio playlists
                let playlists = [];
                try {
                    const res = await plex.query('/playlists?playlistType=audio&X-Plex-Container-Start=0&X-Plex-Container-Size=100');
                    playlists = (res.MediaContainer && res.MediaContainer.Metadata) || [];
                } catch (err) {
                    return dmChannel.send(`❌ Could not list playlists for ${targetUser.username}: ${err.message || err}`);
                }
                if (!playlists.length) {
                    return dmChannel.send(`📋 ${targetUser.username} has no audio playlists.`);
                }
                const numbered = playlists.map((p, i) => `**${i + 1}.** ${p.title} *(${p.leafCount || '?'} tracks)*`).join('\n');
                const pickReply = await promptDM(
                    dmChannel,
                    message.author.id,
                    `📋 **${targetUser.username}'s audio playlists:**\n${numbered}\n\nWhich one? Reply with a number 1-${playlists.length}.\n*(Type \`cancel\` to abort.)*`
                );
                if (!pickReply) return dmChannel.send('🕰️ Cancelled.');
                const pickIdx = parseInt(pickReply, 10) - 1;
                if (isNaN(pickIdx) || pickIdx < 0 || pickIdx >= playlists.length) {
                    return dmChannel.send(`❌ "${pickReply}" is not a number 1-${playlists.length}. Cancelled.`);
                }
                const chosen = playlists[pickIdx];

                // STEP 4: walk tracks
                let tracks = [];
                try {
                    const res = await plex.query(chosen.key);
                    tracks = (res.MediaContainer && res.MediaContainer.Metadata) || [];
                } catch (err) {
                    return dmChannel.send(`❌ Could not read tracks from "${chosen.title}": ${err.message || err}`);
                }
                if (!tracks.length) {
                    return dmChannel.send(`📋 "${chosen.title}" is empty — nothing to copy.`);
                }
                const onDiskTracks = tracks.map(plexTrackToOnDisk).filter(t => t.cle);
                if (!onDiskTracks.length) {
                    return dmChannel.send(`❌ "${chosen.title}" has tracks but none with valid file keys. Cancelled.`);
                }

                // STEP 5: save name + collision check
                const suggested = slugifyName(chosen.title);
                const nameReply = await promptDM(
                    dmChannel,
                    message.author.id,
                    `💾 Save as? (default: \`${suggested}\`)\nType a name, or just send anything starting with \`ok\` / \`y\` / \`yes\` to accept the default.`
                );
                if (nameReply === null) return dmChannel.send('🕰️ Cancelled.');
                const useDefault = /^(ok|y(es)?)$/i.test(nameReply.trim());
                const localName = useDefault ? suggested : slugifyName(nameReply);

                if (!fs.existsSync(bot.config.playlistsDir)) {
                    fs.mkdirSync(bot.config.playlistsDir, { recursive: true });
                }
                const playlistFile = path.join(bot.config.playlistsDir, `${localName}.playlist`);

                if (fs.existsSync(playlistFile)) {
                    const overwriteReply = await promptDM(
                        dmChannel,
                        message.author.id,
                        `⚠️ A local playlist named \`${localName}\` already exists. Overwrite? (\`y\` / \`n\`)`
                    );
                    if (!overwriteReply || !/^y(es)?$/i.test(overwriteReply.trim())) {
                        return dmChannel.send('🕰️ Cancelled — existing playlist preserved.');
                    }
                }

                // STEP 6: write
                const playlist = { nom: chosen.title, musiques: onDiskTracks };
                fs.writeFileSync(playlistFile, JSON.stringify(playlist, null, 2), 'utf8');

                logger.info(`plex-copy: ${message.author.username} copied ${onDiskTracks.length} tracks from ${targetUser.username}'s "${chosen.title}" → ${localName}.playlist`);
                await dmChannel.send(
                    `✅ Copied **${onDiskTracks.length} tracks** from ${targetUser.username}'s *${chosen.title}* into local playlist \`${localName}\`.\n` +
                    `Play it with \`${bot.config.commandPrefix}playlist play ${localName}\``
                );
                await message.channel.send(
                    `✅ <@${message.author.id}> copied **${chosen.title}** from **${targetUser.username}** into local playlist \`${localName}\` *(${onDiskTracks.length} tracks)*.\n` +
                    `Anyone can play it with \`${bot.config.commandPrefix}playlist play ${localName}\`.`
                );
            } catch (err) {
                logger.error('plex-copy wizard failed:', err);
                await dmChannel.send(`❌ Something went wrong: ${err.message || err}`).catch(() => {});
            }
        }
    }
};
