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

// The Perfected Shadow Clone
async function ghostType(targetMsg, eventName, text, waitTime) {
    const clonedMsg = Object.create(targetMsg);

    Object.defineProperty(clonedMsg, 'content', { value: text, enumerable: true });
    Object.defineProperty(clonedMsg, 'cleanContent', { value: text, enumerable: true });
    clonedMsg.toString = () => text;

    clonedMsg.reply = async (content) => {
        return await targetMsg.channel.send(content);
    };

    targetMsg.client.emit(eventName, clonedMsg);

    await new Promise(resolve => setTimeout(resolve, waitTime));
}

module.exports = {
    name: 'vibe',
    command: {
        usage: '!vibe [setting or mood] + [optional: duration or track count]',
        description: 'Instantly generate and queue a thematic playlist based on a vibe using deep Plex tag filtering.',
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
                return msg.channel.send("🎧 **You need to give me a vibe!** Try: `!vibe 1 hour of cyberpunk nightclub` or `!vibe spooky forest`.");
            }

            // THE UPGRADE: The TTRPG Interception
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

                // Apply constraints overrides
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
                const rawInputLower = rawInput.toLowerCase();

                // Prepare searchable terms from the user's prompt by removing generic filler
                const fillerWords = ['of', 'the', 'and', 'in', 'a', 'some', 'music', 'mix', 'playlist', 'for', 'my', 'hour', 'minutes', 'mins'];
                const searchTerms = rawInputLower.split(/\s+/).filter(w => w.length > 2 && !fillerWords.includes(w));

                let scoredItems = allItems.map(item => {
                    let score = 0;

                    let tGenres = item.Genre ? item.Genre.map(g => g.tag.toLowerCase()) : [];
                    let tMoods = item.Mood ? item.Mood.map(m => m.tag.toLowerCase()) : [];
                    let tStyles = item.Style ? item.Style.map(s => s.tag.toLowerCase()) : [];

                    const title = item.title || "Unknown Title";
                    const artist = item.grandparentTitle || "Unknown Artist";
                    const album = item.parentTitle || "Unknown Album";

                    // EXPLICIT REQUEST BOOST:
                    // If the user's raw input directly contains a tag that exists in Plex, prioritize it MASSIVELY
                    tGenres.forEach(tg => { if (tg.length > 2 && rawInputLower.includes(tg)) score += 15; });
                    tStyles.forEach(ts => { if (ts.length > 2 && rawInputLower.includes(ts)) score += 10; });
                    tMoods.forEach(tm => { if (tm.length > 2 && rawInputLower.includes(tm)) score += 5; });

                    // DIRECT METADATA BOOST:
                    // If any important keyword from the prompt is in the artist name, title, or album, rocket it to the top.
                    searchTerms.forEach(term => {
                        if (artist.toLowerCase().includes(term)) score += 20;
                        if (title.toLowerCase().includes(term)) score += 20;
                        if (album.toLowerCase().includes(term)) score += 10;
                    });

                    // Also boost if AI-deduced genres or styles appear directly in the title
                    if (typeData.genres) typeData.genres.forEach(g => { if(title.toLowerCase().includes(g.toLowerCase())) score += 15; });
                    if (typeData.styles) typeData.styles.forEach(s => { if(title.toLowerCase().includes(s.toLowerCase())) score += 10; });

                    // Score matching AI-deduced tags
                    if (typeData.genres) typeData.genres.forEach(g => { if(tGenres.some(tg => tg.includes(g.toLowerCase()))) score += 3; });
                    if (typeData.moods) typeData.moods.forEach(m => { if(tMoods.some(tm => tm.includes(m.toLowerCase()))) score += 1; });
                    if (typeData.styles) typeData.styles.forEach(s => { if(tStyles.some(ts => ts.includes(s.toLowerCase()))) score += 1; });

                    // Catch-all: check title/album just in case it explicitly contains the AI's core vibe word
                    if (title.toLowerCase().includes(typeData.vibe.toLowerCase())) score += 2;

                    return { title, artist, album, score };
                });

                // Filter down to tracks that scored points
                let filteredItems = scoredItems.filter(item => item.score > 0);

                if (filteredItems.length === 0) {
                    // Fallback to all items if the tags yielded zero results
                    filteredItems = allItems.map(item => ({
                        title: item.title || "Unknown",
                        artist: item.grandparentTitle || "Unknown",
                        album: item.parentTitle || "Unknown"
                    }));
                } else {
                    // Sort by highest matching scores first
                    filteredItems.sort((a, b) => b.score - a.score);
                }

                // SHRINK THE POOL: Take only the top 60 best matches so perfect matches aren't diluted by hundreds of "close enough" matches
                let topMatches = filteredItems.slice(0, 60);
                let catalog = topMatches.sort(() => 0.5 - Math.random());

                await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\`\n⏳ *The AI Game Master is building your ambiance...*`);

                const curatorPrompt = `
                You are an expert DJ and Game Master. The core vibe is: "${typeData.vibe}"

                CRITICAL INSTRUCTION: If the requested vibe is a highly specific niche genre (e.g., "bardcore", "cyberpunk", "lo-fi"), you MUST strictly reject mainstream, standard artists (e.g., no Bob Dylan or Mumford & Sons for "bardcore") even if they share adjacent acoustic/folk tags in the catalog. ONLY select artists and tracks that genuinely belong to the requested specific niche.

                Analyze this catalog of highly relevant songs (JSON) and select ${aiTargetInstructions} that establish this atmosphere perfectly.
                ${JSON.stringify(catalog)}

                Output ONLY a raw JSON object exactly like this:
                {
                  "playlist": [
                    {"title": "Exact Track Name", "artist": "Artist Name", "reason": "1-sentence pitch"}
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

                let header = `🎧 **${isTTRPG ? 'Ambiance' : 'Vibe'} Locked:** \`${typeData.vibe}\`\nQueuing up ${aiResponse.playlist.length} tracks (\`${constraintText}\`)...\n\n`;
                let chunks = [];
                let currentChunk = header;

                aiResponse.playlist.forEach(track => {
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
                // MUSIC QUEUE INTEGRATION ZONE
                // ==========================================

                const eventName = msg.client.listeners('messageCreate').length > 0 ? 'messageCreate' : 'message';

                for (let i = 0; i < aiResponse.playlist.length; i++) {
                    const track = aiResponse.playlist[i];
                    let needsPlaysong = false;

                    const filter = m => m.author.id === msg.client.user.id && m.content.toLowerCase().includes('playsong');
                    const collector = msg.channel.createMessageCollector({ filter, time: 3500 });

                    collector.on('collect', () => {
                        needsPlaysong = true;
                        collector.stop();
                    });

                    const searchQuery = `!play ${track.title}`;

                    await ghostType(msg, eventName, searchQuery, 3500);

                    if (needsPlaysong) {
                        await ghostType(msg, eventName, `!playsong 1`, 1500);
                    }
                }

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            }
        }
    }
};