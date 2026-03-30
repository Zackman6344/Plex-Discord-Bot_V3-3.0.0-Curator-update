const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const handleAIError = require('../helpers/aiErrorHandler.js');

const genAI = new GoogleGenerativeAI(keys.geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

const plex = new PlexAPI({
    hostname: plexConfig.hostname,
    port: plexConfig.port,
    https: plexConfig.https,
    token: plexConfig.token,
    options: plexConfig.options
});

module.exports = {
    name: 'sonic',
    command: {
        usage: '!sonic [setting/mood OR specific song] + [optional: duration or track count]',
        description: 'Uses Plex Sonic Analysis strictly to build a playlist around an AI-selected vibe or a specific anchor track.',
        process: async function(...args) {
            let msg = null;
            let commandArgs = [];

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                } else if (typeof arg === 'string') {
                    commandArgs.push(arg);
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            const rawInput = commandArgs.join(" ").trim();
            if (!rawInput) {
                return msg.channel.send("🎧 **I need a starting point!** Try a vibe (`!sonic cyberpunk nightclub`) or a specific song (`!sonic songs like Master of Puppets`).");
            }

            let statusMsg = await msg.channel.send(`🎵 **Sonic Vibe Initializing...**\n⏳ *Decoding your request...*`);

            try {
                // 1. THE SMART PARSER
                const typePrompt = `
                The user requested a Plex Sonic playlist: "${rawInput}"

                Tasks:
                1. Check if the user is explicitly naming a SPECIFIC song or artist to base the playlist around.
                   - If YES: set "isSpecificSong" to true and extract the exact song/artist name into "specificQuery".
                   - If NO (it's just a mood): set "isSpecificSong" to false.
                2. Extract the core vibe if it is not a specific song.
                3. Determine if the user asked for a specific number of tracks or a target duration.
                4. If it IS a vibe, generate an EXHAUSTIVE array of keywords/genres to search the database.

                Output ONLY a raw JSON object exactly like this:
                {
                    "isSpecificSong": false,
                    "specificQuery": "exact song name and artist if applicable",
                    "vibe": "the core setting",
                    "keywords": ["word1", "word2"],
                    "trackCount": 5,
                    "durationMinutes": null
                }
                `;

                const typeResult = await model.generateContent(typePrompt);
                const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { isSpecificSong: false, vibe: rawInput, keywords: [], trackCount: null, durationMinutes: null };

                let targetTrackCount = 5;
                let constraintText = "Standard Sonic Mix";

                if (typeData.trackCount) {
                    targetTrackCount = typeData.trackCount;
                    constraintText = `${targetTrackCount} Tracks`;
                } else if (typeData.durationMinutes) {
                    constraintText = `~${typeData.durationMinutes} Minutes`;
                    targetTrackCount = Math.ceil(typeData.durationMinutes / 3.5);
                }

                let displayTarget = typeData.isSpecificSong ? `Anchor: ${typeData.specificQuery}` : `Vibe: ${typeData.vibe}`;
                await statusMsg.edit(`🎵 **Target:** \`${displayTarget}\` | **Length:** \`${constraintText}\`\n⏳ *Pulling library files from The Nerdgasm...*`);

                const sections = await plex.query('/library/sections');
                const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === 'artist');

                if (!targetSection) {
                    return statusMsg.edit(`❌ Couldn't find a music library on the server!`);
                }

                const libraryData = await plex.query(`/library/sections/${targetSection.key}/all?type=10`);
                const allItems = libraryData.MediaContainer.Metadata || [];

                let aiAnchor = null;

                // ==========================================
                // PATH A: SPECIFIC SONG MATCHING
                // ==========================================
                if (typeData.isSpecificSong && typeData.specificQuery) {
                    await statusMsg.edit(`🎵 **Target:** \`${displayTarget}\`\n⏳ *Scanning the vault for your exact anchor track...*`);

                    const queryWords = typeData.specificQuery.toLowerCase().split(' ');

                    const match = allItems.find(item => {
                        const title = (item.title || "").toLowerCase();
                        const artist = (item.grandparentTitle || "").toLowerCase();
                        const combined = `${title} ${artist}`;
                        return queryWords.every(word => combined.includes(word));
                    });

                    if (match) {
                        aiAnchor = {
                            title: match.title,
                            artist: match.grandparentTitle || "Unknown Artist",
                            ratingKey: match.ratingKey,
                            reason: `Requested Anchor Track.`
                        };
                    } else {
                        return statusMsg.edit(`❌ I couldn't find any track matching **"${typeData.specificQuery}"** in the vault!`);
                    }
                }
                // ==========================================
                // PATH B: AI VIBE CURATION
                // ==========================================
                else {
                    await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\`\n⏳ *Sifting through audio tracks...*`);

                    let fallbackCatalog = [];
                    const lowerKeywords = typeData.keywords.map(k => k.toLowerCase());

                    allItems.forEach(item => {
                        const title = item.title || "Unknown Title";
                        const artist = item.grandparentTitle || "Unknown Artist";
                        const album = item.parentTitle || "Unknown Album";
                        const summary = `A song by ${artist} from the album ${album}.`;

                        const lowerTitle = title.toLowerCase();
                        const lowerSummary = summary.toLowerCase();

                        if (lowerKeywords.some(keyword => lowerTitle.includes(keyword) || lowerSummary.includes(keyword))) {
                            fallbackCatalog.push({ title, artist, ratingKey: item.ratingKey });
                        }
                    });

                    if (fallbackCatalog.length === 0) fallbackCatalog = allItems;

                    let aiChoices = fallbackCatalog.sort(() => 0.5 - Math.random()).slice(0, 300);
                    await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\`\n⏳ *The AI DJ is hunting for the perfect Anchor Track...*`);

                    const curatorPrompt = `
                    You are an expert DJ creating atmospheric soundtracks.
                    The core vibe/setting is: "${typeData.vibe}"

                    Analyze this catalog of songs (JSON) and select EXACTLY ONE "Anchor Track" that perfectly defines this atmosphere.
                    ${JSON.stringify(aiChoices)}

                    Output ONLY a raw JSON object exactly like this:
                    {
                      "title": "Exact Track Name",
                      "artist": "Artist Name",
                      "ratingKey": "The Plex ratingKey of the track",
                      "reason": "1-sentence pitch on why this is the perfect starting point"
                    }
                    `;

                    const finalResult = await model.generateContent(curatorPrompt);
                    const jsonMatch = finalResult.response.text().match(/\{[\s\S]*\}/);
                    aiAnchor = JSON.parse(jsonMatch[0]);
                }

                // ==========================================
                // 3. STRICT PLEX SONIC ANALYSIS
                // ==========================================
                await statusMsg.edit(`🎵 **Anchor Locked:** **${aiAnchor.title}** by ${aiAnchor.artist}\n⏳ *Unpacking Plex Hubs for Sonic Data...*`);

                let finalPlaylist = [{
                    title: aiAnchor.title,
                    artist: aiAnchor.artist,
                    reason: `🌟 **Anchor Track:** *${aiAnchor.reason}*`
                }];

                try {
                    const sonicData = await plex.query(`/library/metadata/${aiAnchor.ratingKey}/related`);
                    const hubs = sonicData.MediaContainer.Hub || [];

                    // Strictly hunt for the Sonic Hub. No fallbacks allowed.
                    const sonicHub = hubs.find(h =>
                        (h.context && h.context.toLowerCase().includes('sonic')) ||
                        (h.hubIdentifier && h.hubIdentifier.toLowerCase().includes('sonic'))
                    );

                    if (sonicHub && sonicHub.Metadata && sonicHub.Metadata.length > 0) {
                        const similarTracks = sonicHub.Metadata;
                        const limit = targetTrackCount - 1;

                        for (let i = 0; i < Math.min(similarTracks.length, limit); i++) {
                            finalPlaylist.push({
                                title: similarTracks[i].title,
                                artist: similarTracks[i].grandparentTitle || "Unknown Artist",
                                reason: "🎵 *Plex Sonic Match*"
                            });
                        }
                    } else {
                        // HONEST FAILURE: Tell the user Sonic Data is missing.
                        return statusMsg.edit(`❌ **Sonic Analysis Failed:** I found the anchor track (**${aiAnchor.title}**), but Plex has not sonically analyzed it yet! Try a different vibe or specific song.`);
                    }
                } catch (e) {
                    console.error("Sonic API error:", e);
                    return statusMsg.edit(`❌ **API Error:** The Plex server rejected the Sonic query for **${aiAnchor.title}**.`);
                }

                await statusMsg.delete().catch(() => {});

                let reply = `📻 **Sonic Radio:** \`${displayTarget}\`\nQueuing up ${finalPlaylist.length} tracks...\n\n`;
                finalPlaylist.forEach((track, index) => {
                    reply += `${index === 0 ? '🎯' : '🎶'} **${track.title}** by ${track.artist}\n> ${track.reason}\n\n`;
                });

                await msg.channel.send(reply);

                // ==========================================
                // 4. MUSIC QUEUE INTEGRATION ZONE (THE PROVEN !VIBE METHOD)
                // ==========================================

                const originalContent = msg.content;
                const eventName = msg.client.listeners('messageCreate').length > 0 ? 'messageCreate' : 'message';

                for (const track of finalPlaylist) {
                    let needsPlaysong = false;

                    const filter = m => m.author.id === msg.client.user.id && m.content.toLowerCase().includes('playsong');
                    const collector = msg.channel.createMessageCollector({ filter, time: 3500 });

                    collector.on('collect', m => {
                        needsPlaysong = true;
                        collector.stop();
                    });

                    // We add the word "song" to help the search engine lock onto the track instead of the album
                    msg.content = `!play ${track.title} ${track.artist} song`;
                    msg.client.emit(eventName, msg);

                    await new Promise(resolve => setTimeout(resolve, 3500));

                    if (needsPlaysong) {
                        msg.content = `!playsong 1`;
                        msg.client.emit(eventName, msg);
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                }

                msg.content = originalContent;

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            }
        }
    }
};