const { getModel } = require('../helpers/geminiAPI.js');
const { getPlex } = require('../helpers/plexClient.js');
const handleAIError = require('../helpers/aiErrorHandler.js');
const logger = require('../helpers/logger.js');
const plexTags = require('../helpers/plexTags.js');

const model = getModel();
const plex = getPlex();

// The Interactive Prompt Helper
const promptUser = async (channel, authorId, text, time = 30000) => {
    if (text) await channel.send(text);
    const filter = m => m.author.id === authorId;
    try {
        const collected = await channel.awaitMessages({ filter, max: 1, time, errors: ['time'] });
        return collected.first().content.trim();
    } catch (e) {
        // Timeout rejects with the (empty) collection; a real Error would otherwise be
        // reported to the user as "you took too long".
        if (e instanceof Error) logger.error('Prompt failed:', e);
        return null;
    }
};

// Array shuffler helper
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

module.exports = {
    name: 'vibe',
    command: {
        usage: '!vibe [setting or mood] + [optional: duration or track count]',
        description: 'Instantly generate and queue a thematic playlist based on a vibe using deep Plex tag filtering.',
        slash: {
            description: 'Generate a thematic playlist from a vibe',
            options: [
                { name: 'vibe', type: 'STRING', required: true,
                  description: 'Setting or mood, optionally with a duration or track count' },
                { name: 'ttrpg', type: 'BOOLEAN', required: false, omitFromQuery: true,
                  description: 'Background ambiance for a tabletop session (skips the follow-up question)' }
            ]
        },
        process: async function(bot, client, msg, query) {

            if (!msg) return logger.error("Critical Error: Could not locate the Discord message object!");

            const rawInput = query ? query.trim() : '';
            if (!rawInput) {
                return msg.channel.send("🎧 **You need to give me a vibe!** Try: `!vibe 1 hour of cyberpunk nightclub` or `!vibe spooky forest`.");
            }

            // A slash user answers this up front with the ttrpg option; the prefix path (and a
            // slash invocation that left it unset) still gets asked in-channel.
            let isTTRPG = null;
            const slashOpts = msg.interaction && msg.interaction.options;
            if (slashOpts && typeof slashOpts.getBoolean === 'function') {
                const chosen = slashOpts.getBoolean('ttrpg');
                if (chosen !== null && chosen !== undefined) isTTRPG = chosen;
            }

            if (isTTRPG === null) {
                const affirmitiveWords = ['yes', 'y', 'yeah', 'yep', 'sure', 'tabletop', 'ttrpg'];
                const ttrpgAns = await promptUser(msg.channel, msg.author.id, `🎲 **Quick question:** Is this vibe for a Tabletop RPG session?\n*(Reply **Yes** for a 20-track ambient background queue, or **No** for a standard mix)*`);

                if (!ttrpgAns) {
                    return msg.channel.send("🎧 *Vibe check timed out. Run the command again when you're ready!*");
                }
                isTTRPG = affirmitiveWords.includes(ttrpgAns.toLowerCase());
            }

            let statusMsg = await msg.channel.send(`🎵 **Vibe Check Initializing...**\n⏳ *Decoding your constraints and casting a sonic keyword net...*`);

            try {
                const ttrpgContext = isTTRPG ? "CRITICAL: The user wants instrumental, cinematic, or ambient background music for a Tabletop RPG." : "";

                // The AI picks from the library's real tag vocabulary. Left unconstrained it
                // invents plausible-sounding tags ("driving", "instrumental") that match nothing,
                // which is what made the old filter fall back to scoring on absent fields.
                const vocabForPrompt = await plexTags.getVocabulary();
                const moodVocab = vocabForPrompt.moods.map(m => m.title);
                const genreVocab = vocabForPrompt.genres.map(g => g.title);

                const typePrompt = `
                The user requested a music playlist: "${rawInput}"
                ${ttrpgContext}

                Tasks:
                1. Extract the core vibe/setting.
                2. Determine if the user asked for a specific number of tracks OR a target duration in minutes. If neither, return null.
                3. List any specific recording artists the user named. Empty array if none.
                4. Choose moods and genres from the CLOSED LISTS below.

                MOODS AVAILABLE (choose only from this list, copying names exactly):
                ${JSON.stringify(moodVocab)}

                GENRES AVAILABLE (choose only from this list, copying names exactly):
                ${JSON.stringify(genreVocab)}

                CRITICAL RULES for tag selection:
                - Include EVERY tag from the lists that could plausibly fit the request, not a token
                  handful. Breadth here is good: it widens the candidate pool the next stage curates
                  from. Twenty accurate moods beat three.
                - Never invent a tag. If a word the user used isn't in a list, express it through
                  whichever listed tags come closest.
                - If nothing in a list fits at all, return an empty array for it.

                Output ONLY a raw JSON object exactly like this:
                {
                    "vibe": "the core setting",
                    "artists": [],
                    "genres": ["Electronic"],
                    "moods": ["Energetic", "Dramatic", "Exciting"],
                    "trackCount": 5,
                    "durationMinutes": null
                }
                `;

                const typeResult = await model.generateContent(typePrompt);
                const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { vibe: rawInput, genres: [], moods: [], styles: [], trackCount: null, durationMinutes: null };

                let constraintText = "Standard DJ Mix";
                let aiTargetInstructions = "between 3 and 6 tracks";

                if (isTTRPG) {
                    constraintText = "TTRPG Background Ambiance (Up to 20 Tracks)";
                    aiTargetInstructions = "up to 20 tracks (aim for exactly 20 if possible). FOCUS ENTIRELY on instrumental, atmospheric, or cinematic tracks that serve as excellent background music without distracting the players.";
                } else if (typeData.trackCount) {
                    constraintText = `${typeData.trackCount} Tracks`;
                    aiTargetInstructions = `EXACTLY ${typeData.trackCount} tracks`;
                } else if (typeData.durationMinutes) {
                    constraintText = `~${typeData.durationMinutes} Minutes`;
                    const estimatedTracks = Math.ceil(typeData.durationMinutes / 3.5);
                    aiTargetInstructions = `roughly ${estimatedTracks} tracks`;
                }

                await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\` | **Target:** \`${constraintText}\`\n⏳ *Cross-referencing Plex tags with: ${[...(typeData.genres || []), ...(typeData.moods || [])].join(", ")}...*`);

                const vocab = await plexTags.getVocabulary();
                if (!vocab.sectionKey) {
                    return statusMsg.edit(`❌ Couldn't find a music library on the server!`);
                }

                // Ask Plex for exactly the tracks carrying the tags the AI chose, instead of
                // pulling the whole library and scoring it against Mood/Style fields that a
                // section listing never returns. Every matched tag below is one Plex assigned.
                const tagHits = await plexTags.fetchTracksByTags(typeData.moods || [], typeData.genres || []);

                if (tagHits.unknown.length) {
                    logger.debug(`vibe: AI proposed tags absent from the library vocabulary: ${tagHits.unknown.join(', ')}`);
                }

                // A named artist won't show up under a mood tag, so look those up separately.
                const requestedArtists = [];
                const artistTracks = [];
                for (const name of (typeData.artists || []).slice(0, 5)) {
                    try {
                        const res = await plex.query(`/search/?type=10&query=${encodeURI(name)}&X-Plex-Container-Start=0&X-Plex-Container-Size=100`);
                        const found = (res.MediaContainer && res.MediaContainer.Metadata) || [];
                        if (found.length) {
                            requestedArtists.push(name);
                            for (const t of found) artistTracks.push({ track: t, matchedMoods: [], matchedGenres: [], requestedArtist: true });
                        }
                    } catch (err) {
                        logger.warn(`vibe: artist lookup failed for "${name}":`, err.message || err);
                    }
                }

                const byKey = new Map();
                for (const entry of [...tagHits.tracks, ...artistTracks]) {
                    const id = entry.track.ratingKey;
                    if (!byKey.has(id)) byKey.set(id, entry);
                    else if (entry.requestedArtist) byKey.get(id).requestedArtist = true;
                }

                if (byKey.size === 0) {
                    // Previously this fell back to "every playable track", then presented 75 random
                    // songs as a curated vibe. Saying nothing matched is more useful than that.
                    const tried = [...tagHits.usedMoods, ...tagHits.usedGenres].join(', ') || 'nothing usable';
                    return statusMsg.edit(
                        `🎧 **No matches for that vibe.**\nI mapped it to: \`${tried}\` — but no tracks in the library carry those tags.\n` +
                        `*Try naming a genre or artist you know is on the server, or a broader mood.*`
                    );
                }

                const rawInputLower = rawInput.toLowerCase();
                const fillerWords = ['of', 'the', 'and', 'in', 'a', 'some', 'music', 'mix', 'playlist', 'for', 'my', 'hour', 'minutes', 'mins'];
                const searchTerms = rawInputLower.split(/\s+/).filter(w => w.length > 2 && !fillerWords.includes(w));

                let scoredItems = [...byKey.values()].map((entry) => {
                    const item = entry.track;
                    const plexKey = item.Media?.[0]?.Part?.[0]?.key;
                    if (!plexKey) return { score: -1 };

                    const title = item.title || "Unknown Title";
                    const artist = item.originalTitle || item.grandparentTitle || "Unknown Artist";
                    const album = item.parentTitle || "Unknown Album";

                    // Tag matches are the signal: the track is here because Plex tagged it that way.
                    let score = entry.matchedMoods.length * 8 + entry.matchedGenres.length * 5;
                    if (entry.requestedArtist) score += 40;

                    // Literal text hits still count, but can no longer outweigh the tags the way a
                    // 20-point title match once did.
                    searchTerms.forEach(term => {
                        if (artist.toLowerCase().includes(term)) score += 6;
                        if (title.toLowerCase().includes(term)) score += 4;
                        if (album.toLowerCase().includes(term)) score += 2;
                    });
                    if (typeData.vibe && title.toLowerCase().includes(typeData.vibe.toLowerCase())) score += 2;

                    return {
                        title, artist, album, score, plexKey,
                        duration: item.duration || null,
                        tags: [...entry.matchedMoods, ...entry.matchedGenres]
                    };
                });

                let filteredItems = scoredItems.filter(item => item.score > 0);
                if (filteredItems.length === 0) {
                    return statusMsg.edit(`🎧 **Nothing scored high enough for that vibe.** Try a broader mood or a specific artist.`);
                }
                filteredItems.sort((a, b) => b.score - a.score);

                let diverseCatalog = [];
                let artistTracker = {};
                const MAX_TRACKS_PER_ARTIST = 3;

                for (let i = 0; i < filteredItems.length; i++) {
                    const item = filteredItems[i];
                    if (!artistTracker[item.artist]) artistTracker[item.artist] = 0;

                    const isRequestedArtist = requestedArtists.some(ra => ra.toLowerCase() === item.artist.toLowerCase());
                    const currentLimit = isRequestedArtist ? 50 : MAX_TRACKS_PER_ARTIST;

                    if (artistTracker[item.artist] < currentLimit) {
                        diverseCatalog.push(item);
                        artistTracker[item.artist]++;
                    }
                    if (diverseCatalog.length >= 75) break;
                }

                // ID MAPPING FIX: Assign an integer ID to each track so the LLM doesn't have to output massive JSON strings.
                let catalog = shuffleArray(diverseCatalog).map((item, index) => ({
                    id: index,
                    title: item.title,
                    artist: item.artist,
                    album: item.album,
                    plexKey: item.plexKey,
                    tags: item.tags
                }));

await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\`\n⏳ *The AI Librarian is analyzing metadata...*`);

                // DYNAMIC AI RULE: Tell the AI it is allowed to spam an artist if the user asked for them
                let diversityRule = `2. ARTIST DIVERSITY: You MUST NOT select more than 2 tracks by the exact same artist. Spread the selections around.`;
                if (requestedArtists.length > 0) {
                    diversityRule = `2. ARTIST FOCUS: The user explicitly requested music by ${requestedArtists.join(", ")}. You may select as many tracks by these artists as you see fit, ignoring normal diversity limits.`;
                }

                // Send a lightweight catalog to the LLM WITH tags attached
                const curatorPrompt = `
                You are an analytical Music Librarian AI. The core requested vibe is: "${typeData.vibe}"

                CRITICAL RULES:
                1. GENRE COHESION: Do NOT induce sonic whiplash. Pick a sonic lane that best fits the vibe and strictly adhere to it.
                ${diversityRule}
                3. TECHNICAL REASONING ONLY: Completely exclude flavorful, emotional, or "DJ pitch" style text. The 'reason' field MUST be a clinical explanation of why this track was selected based on its metadata tags and prompt relevance.

                Analyze this catalog of highly relevant songs (JSON) and select ${aiTargetInstructions}.
                ${JSON.stringify(catalog.map(c => ({id: c.id, title: c.title, artist: c.artist, tags: c.tags.slice(0, 5)})))}

                Output ONLY a raw JSON object exactly like this:
                {
                  "playlist": [
                    {"id": 0, "reason": "Matched tags: [tag1, tag2]. Selected because [Technical alignment explanation]"}
                  ]
                }
                `;

                const finalResult = await model.generateContent(curatorPrompt);
                const jsonMatch = finalResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const aiResponse = JSON.parse(jsonMatch[0]);
                await statusMsg.delete().catch(() => {});

                if (!aiResponse.playlist || aiResponse.playlist.length === 0) {
                    return msg.channel.send(`Yikes. I couldn't find any music in the vault that matches that specific vibe.`);
                }

                // Decode the IDs back into full track objects
                let finalPlaylist = [];
                aiResponse.playlist.forEach(pick => {
                    const trackData = catalog.find(c => c.id === pick.id);
                    if (trackData) {
                        finalPlaylist.push({ ...trackData, reason: pick.reason });
                    }
                });

                finalPlaylist = shuffleArray(finalPlaylist);

                let header = `🎧 **${isTTRPG ? 'Ambiance' : 'Vibe'} Locked:** \`${typeData.vibe}\`\nQueuing up ${finalPlaylist.length} tracks (\`${constraintText}\`)...\n\n`;
                let chunks = [];
                let currentChunk = header;

                finalPlaylist.forEach(track => {
                    let trackDisplay = `🎶 **${track.title}** by ${track.artist}\n> *${track.reason}*\n\n`;
                    if (currentChunk.length + trackDisplay.length > 1900) {
                        chunks.push(currentChunk);
                        currentChunk = "";
                    }
                    currentChunk += trackDisplay;
                });
                if (currentChunk.length > 0) chunks.push(currentChunk);

                for (const chunk of chunks) {
                    await msg.channel.send(chunk);
                }

                // ==========================================
                // DIRECT QUEUE INJECTION (OVERENGINEERED FIX)
                // ==========================================

                let queuedCount = 0;
                finalPlaylist.forEach(track => {
                    // Push exact memory object directly into the bot's core state
                    bot.songQueue.push({
                        artist: track.artist,
                        title: track.title,
                        album: track.album,
                        key: track.plexKey
                    });
                    queuedCount++;
                });

                // If the bot isn't currently playing anything, start the music loop!
                if (queuedCount > 0 && !bot.isPlaying) {
                    bot.playSong(msg);
                }

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            }
        }
    }
};