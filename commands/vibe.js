const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');

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
        description: 'Instantly generate and queue a thematic playlist based on a vibe',
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
                3. Generate an EXHAUSTIVE array of keywords, genres, instruments, and sonic themes.

                Output ONLY a raw JSON object exactly like this:
                {
                    "vibe": "the core setting",
                    "keywords": ["word1", "word2"],
                    "trackCount": 5,
                    "durationMinutes": null
                }
                `;

                const typeResult = await model.generateContent(typePrompt);
                const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { vibe: rawInput, keywords: [], trackCount: null, durationMinutes: null };

                let constraintText = "Standard DJ Mix";
                let aiTargetInstructions = "between 3 and 6 tracks";

                // THE UPGRADE: Apply TTRPG Overrides
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

                await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\` | **Target:** \`${constraintText}\`\n⏳ *Connecting to The Nerdgasm Plex server...*`);

                const sections = await plex.query('/library/sections');
                const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === 'artist');

                if (!targetSection) {
                    return statusMsg.edit(`❌ Couldn't find a music library on the server!`);
                }

                const libraryData = await plex.query(`/library/sections/${targetSection.key}/all?type=10`);
                const allItems = libraryData.MediaContainer.Metadata || [];

                let filteredItems = [];
                const lowerKeywords = typeData.keywords.map(k => k.toLowerCase());

                allItems.forEach(item => {
                    const title = item.title || "Unknown Title";
                    const artist = item.grandparentTitle || "Unknown Artist";
                    const album = item.parentTitle || "Unknown Album";
                    const summary = `A song by ${artist} from the album ${album}.`;

                    const lowerTitle = title.toLowerCase();
                    const lowerSummary = summary.toLowerCase();

                    if (lowerKeywords.some(keyword => lowerTitle.includes(keyword) || lowerSummary.includes(keyword)) || lowerKeywords.length === 0) {
                        filteredItems.push({ title, artist, album });
                    }
                });

                if (filteredItems.length === 0) {
                    filteredItems = allItems.map(item => ({
                        title: item.title || "Unknown",
                        artist: item.grandparentTitle || "Unknown"
                    }));
                }

                let catalog = filteredItems.sort(() => 0.5 - Math.random()).slice(0, 3000);

                await statusMsg.edit(`🎵 **Vibe:** \`${typeData.vibe}\`\n⏳ *The AI Game Master is building your ambiance...*`);

                const curatorPrompt = `
                You are an expert DJ and Game Master. The core vibe is: "${typeData.vibe}"

                Analyze this catalog of songs (JSON) and select ${aiTargetInstructions} that establish this atmosphere perfectly.
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
                console.error(err);
                statusMsg.edit("❌ *I hit a snag trying to generate that playlist.*").catch(() => {});
            }
        }
    }
};