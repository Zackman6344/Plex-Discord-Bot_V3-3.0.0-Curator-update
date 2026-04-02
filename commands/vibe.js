const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const handleAIError = require('../helpers/aiErrorHandler.js');

const genAI = new GoogleGenerativeAI(keys.geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" });

const plex = new PlexAPI({
    hostname: plexConfig.hostname,
    port: plexConfig.port,
    https: plexConfig.https,
    token: plexConfig.token,
    options: plexConfig.options
});

// The Interactive Prompt Helper
const promptUser = async (channel, authorId, text, time = 30000) => {
    if (text) await channel.send(text);
    const filter = m => m.author.id === authorId;
    try {
        const collected = await channel.awaitMessages({ filter, max: 1, time, errors: ['time'] });
        return collected.first().content.trim();
    } catch (e) {
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
        process: async function(bot, client, msg, query) {

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            const rawInput = query ? query.trim() : '';
            if (!rawInput) {
                return msg.channel.send("🎧 **You need to give me a vibe!** Try: `!vibe 1 hour of cyberpunk nightclub` or `!vibe spooky forest`.");
            }

            const affirmitiveWords = ['yes', 'y', 'yeah', 'yep', 'sure', 'tabletop', 'ttrpg'];
            const ttrpgAns = await promptUser(msg.channel, msg.author.id, `🎲 **Quick question:** Is this vibe for a Tabletop RPG session?\n*(Reply **Yes** for a 20-track ambient background queue, or **No** for a standard mix)*`);

            if (!ttrpgAns) {
                return msg.channel.send("🎧 *Vibe check timed out. Run the command again when you're ready!*");
            }

            let isTTRPG = affirmitiveWords.includes(ttrpgAns.toLowerCase());

            let statusMsg = await msg.channel.send(`🎵 **Vibe Check Initializing...**\n⏳ *Decoding your constraints and casting a sonic keyword net...*`);

            try {
                const ttrpgContext = isTTRPG ? "CRITICAL: The user wants instrumental, cinematic, or ambient background music for a Tabletop RPG." : "";

                const typePrompt = `
                The user requested a music playlist: "${rawInput}"
                ${ttrpgContext}

                Tasks:
                1. Extract the core vibe/setting.
                2. Determine if the user asked for a specific number of tracks OR a target duration in minutes. If neither, return null.
                3. Deduce the implied genres, moods, and styles to search a music database. Keep arrays small (2-4 words each).
                CRITICAL: If the user explicitly names a specific genre or style (e.g., "bardcore", "synthwave"), you MUST include that exact word in the 'genres' or 'styles' array!

                Output ONLY a raw JSON object exactly like this:
                {
                    "vibe": "the core setting",
                    "genres": ["synthwave", "electronic"],
                    "moods": ["energetic", "dark"],
                    "styles": ["driving", "instrumental"],
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

                const sections = await plex.query('/library/sections');
                const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === 'artist');

                if (!targetSection) {
                    return statusMsg.edit(`❌ Couldn't find a music library on the server!`);
                }

                const libraryData = await plex.query(`/library/sections/${targetSection.key}/all?type=10`);
                const allItems = libraryData.MediaContainer.Metadata || [];

                if (allItems.length === 0) {
                    return statusMsg.edit(`❌ The music library is empty!`);
                }

                   // ==========================================
                // THE NEW DEEP METADATA CROSS-FILTER
                // ==========================================

                // STRINGER FIX: Strip punctuation and weird spaces for a pure alphanumeric comparison
                const normalizeString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
                const normalizedInput = normalizeString(rawInput);

                const fillerWords = ['of', 'the', 'and', 'in', 'a', 'some', 'music', 'mix', 'playlist', 'for', 'my', 'hour', 'minutes', 'mins'];
                const searchTerms = rawInput.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !fillerWords.includes(w));

                // METADATA FIX: Extract Album Artists AND Track-Specific Artists (to catch compilation albums)
                const allUniqueArtists = [...new Set(allItems.flatMap(item => [item.grandparentTitle, item.originalTitle]).filter(Boolean))];

                const requestedArtists = allUniqueArtists.filter(artist => {
                    const normArtist = normalizeString(artist);
                    if (normArtist.length < 3) return false;

                    // Use a word boundary regex so asking for "Rush" doesn't accidentally trigger on "Brush"
                    const regex = new RegExp(`\\b${normArtist}\\b`, 'i');
                    return regex.test(normalizedInput);
                });

                let scoredItems = allItems.map((item) => {
                    let score = 0;

                    // DIRECT MEMORY FIX: Extract the actual media file path to bypass the search engine entirely.
                    const plexKey = item.Media?.[0]?.Part?.[0]?.key;
                    if (!plexKey) return { score: -1 };

                    let tGenres = item.Genre ? item.Genre.map(g => g.tag.toLowerCase()) : [];
                    let tMoods = item.Mood ? item.Mood.map(m => m.tag.toLowerCase()) : [];
                    let tStyles = item.Style ? item.Style.map(s => s.tag.toLowerCase()) : [];

                    const title = item.title || "Unknown Title";
                    // Fallback from Track Artist -> Album Artist -> Unknown
                    const artist = item.originalTitle || item.grandparentTitle || "Unknown Artist";
                    const album = item.parentTitle || "Unknown Album";

                    tGenres.forEach(tg => { if (tg.length > 2 && rawInputLower.includes(tg)) score += 15; });
                    tStyles.forEach(ts => { if (ts.length > 2 && rawInputLower.includes(ts)) score += 10; });
                    tMoods.forEach(tm => { if (tm.length > 2 && rawInputLower.includes(tm)) score += 5; });

                    searchTerms.forEach(term => {
                        if (artist.toLowerCase().includes(term)) score += 20;
                        if (title.toLowerCase().includes(term)) score += 20;
                        if (album.toLowerCase().includes(term)) score += 10;
                    });

                    if (typeData.genres) typeData.genres.forEach(g => { if(title.toLowerCase().includes(g.toLowerCase())) score += 15; });
                    if (typeData.styles) typeData.styles.forEach(s => { if(title.toLowerCase().includes(s.toLowerCase())) score += 10; });

                    if (typeData.genres) typeData.genres.forEach(g => { if(tGenres.some(tg => tg.includes(g.toLowerCase()))) score += 3; });
                    if (typeData.moods) typeData.moods.forEach(m => { if(tMoods.some(tm => tm.includes(m.toLowerCase()))) score += 1; });
                    if (typeData.styles) typeData.styles.forEach(s => { if(tStyles.some(ts => ts.includes(s.toLowerCase()))) score += 1; });

                    if (title.toLowerCase().includes(typeData.vibe.toLowerCase())) score += 2;

                    // UPDATED: Now saving the tags so the LLM can actually see them
                                        return {
                                            title,
                                            artist,
                                            album,
                                            score,
                                            plexKey,
                                            tags: [...tGenres, ...tMoods, ...tStyles]
                                        };
                                    });

                let filteredItems = scoredItems.filter(item => item.score > 0);

                if (filteredItems.length === 0) {
                    filteredItems = scoredItems.filter(item => item.score > -1); // Fallback to all playable tracks
                } else {
                    filteredItems.sort((a, b) => b.score - a.score);
                }

let diverseCatalog = [];
                let artistTracker = {};
                const MAX_TRACKS_PER_ARTIST = 3;

                for (let i = 0; i < filteredItems.length; i++) {
                    const item = filteredItems[i];
                    if (!artistTracker[item.artist]) artistTracker[item.artist] = 0;

                    // DYNAMIC THRESHOLD: If the user explicitly asked for this artist, remove the cap!
                    const isRequestedArtist = requestedArtists.some(ra => ra.toLowerCase() === item.artist.toLowerCase());
                    const currentLimit = isRequestedArtist ? 50 : MAX_TRACKS_PER_ARTIST;

                    if (artistTracker[item.artist] < currentLimit) {
                        diverseCatalog.push(item);
                        artistTracker[item.artist]++;
                    }
                    if (diverseCatalog.length >= 75) break;
                }

                // ID MAPPING FIX: Assign an integer ID to each track so the LLM doesn't have to output massive JSON strings.
                let catalog = diverseCatalog.sort(() => 0.5 - Math.random()).map((item, index) => ({
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