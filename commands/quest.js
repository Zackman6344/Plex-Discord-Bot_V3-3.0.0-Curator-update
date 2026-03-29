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

const promptUser = async (channel, authorId, text, time = 60000) => {
    if (text) await channel.send(text);
    const filter = m => m.author.id === authorId;
    try {
        const collected = await channel.awaitMessages({ filter, max: 1, time, errors: ['time'] });
        return collected.first().content.trim();
    } catch (e) {
        return null;
    }
};

module.exports = {
    name: 'quest',
    command: {
        usage: '!quest',
        description: 'Build a thematic, narrative-driven media marathon from your Plex server.',
        process: async function(...args) {
            let msg = null;

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            // STAGE 1: Choose the Library Realm
            let libAns = await promptUser(msg.channel, msg.author.id, `🗺️ **Quest Board Accessed!**\n<@${msg.author.id}>, which realm are we charting a course through today?\n\n*(Reply with **Movies**, **TV**, **Both**, or **Music**)*`);

            if (!libAns) return msg.channel.send("🗺️ *You walked away from the quest board. Run `!quest` to try again.*");

            let libChoice = libAns.toLowerCase();
            let targetTypes = [];
            let typeLabel = "";

            if (libChoice.includes('both') || (libChoice.includes('movie') && libChoice.includes('tv'))) {
                targetTypes = ['movie', 'show'];
                typeLabel = "Movies & TV Shows";
            } else if (libChoice.includes('music') || libChoice.includes('song')) {
                targetTypes = ['artist'];
                typeLabel = "Music";
            } else if (libChoice.includes('tv') || libChoice.includes('show')) {
                targetTypes = ['show'];
                typeLabel = "TV Shows";
            } else {
                targetTypes = ['movie'];
                typeLabel = "Movies";
            }

            // STAGE 2: Get the Vibe and Length Constraints
            let questInput = await promptUser(msg.channel, msg.author.id, `Got it. We are exploring **${typeLabel}**.\n\nNow, describe the journey you want to take, and let me know how long it should be! \n*(e.g., "A 5-part journey through 90s hacker paranoia" or "3 hours of spooky forest ambiance")*`);

            if (!questInput) return msg.channel.send("🗺️ *The map remains blank. You took too long to give a description!*");
            if (questInput.toLowerCase() === 'cancel' || questInput.toLowerCase() === 'stop') return msg.channel.send("🗺️ *Quest aborted.*");

            let statusMsg = await msg.channel.send(`📜 **Drafting Quest Parameters...**\n⏳ *Decoding your constraints and casting the keyword net...*`);

            try {
                // 1. THE SMART PARSER & KEYWORD NET
                const typePrompt = `
                The user requested a media quest/marathon: "${questInput}"
                Library type: ${typeLabel}

                Tasks:
                1. Extract the core theme/vibe.
                2. Determine the requested length. If they asked for a duration (e.g., "3 hours"), estimate how many items that is based on the library type (Movies ~2 hrs, TV ~45 mins, Music ~3.5 mins).
                3. Set the "targetCount". STRICT RULE: The targetCount MUST NOT EXCEED 10. If they ask for 20 movies, cap it at 10. If they don't specify a length, default to 3.
                4. Generate an EXHAUSTIVE array of keywords, genres, and themes to search the database.

                Output ONLY a raw JSON object exactly like this:
                {
                    "theme": "the core theme",
                    "keywords": ["word1", "word2"],
                    "targetCount": 5
                }
                `;

                const typeResult = await model.generateContent(typePrompt);
                const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { theme: questInput, keywords: [], targetCount: 3 };

                // Hard enforce the safety cap just in case the AI hallucinates
                let safeCount = Math.min(typeData.targetCount, 10);
                if (safeCount < 1) safeCount = 3;

                await statusMsg.edit(`📜 **Quest Theme:** \`${typeData.theme}\` | **Length:** \`${safeCount} chapters\`\n✅ Netted **${typeData.keywords.length} keywords**\n⏳ *Connecting to The Nerdgasm Plex server...*`);

                // 2. FETCH AND PRE-FILTER PLEX LIBRARIES
                const sections = await plex.query('/library/sections');
                let allItems = [];

                for (const type of targetTypes) {
                    const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === type);
                    if (targetSection) {
                        let queryUrl = `/library/sections/${targetSection.key}/all`;
                        if (type === 'artist') queryUrl += `?type=10`;

                        const libraryData = await plex.query(queryUrl);
                        const items = libraryData.MediaContainer.Metadata || [];

                        // Tag each item so the AI knows if it's a movie or a show when mixing
                        items.forEach(item => {
                            item.librarySource = type;
                            item.sectionTitle = targetSection.title;
                            allItems.push(item);
                        });
                    }
                }

                if (allItems.length === 0) {
                    return statusMsg.edit(`❌ Couldn't find the requested libraries on the server!`);
                }

                await statusMsg.edit(`📜 **Quest Theme:** \`${typeData.theme}\`\n✅ Connected to Plex\n⏳ *Sifting through ${allItems.length} vault files...*`);

                let filteredItems = [];
                const lowerKeywords = typeData.keywords.map(k => k.toLowerCase());

                allItems.forEach(item => {
                    let title = item.title || "Unknown Title";
                    let summary = item.summary || "";
                    let year = item.year || item.parentYear || "Unknown";

                    if (item.librarySource === 'artist') {
                        const artist = item.grandparentTitle || "Unknown Artist";
                        const album = item.parentTitle || "Unknown Album";
                        title = `${title} by ${artist}`;
                        if (!summary) summary = `A track by ${artist} from the album ${album}.`;
                    }

                    const lowerTitle = title.toLowerCase();
                    const lowerSummary = summary.toLowerCase();

                    const hasMatch = lowerKeywords.some(keyword => lowerTitle.includes(keyword) || lowerSummary.includes(keyword));
                    if (hasMatch || lowerKeywords.length === 0) {
                        filteredItems.push({
                            title: title,
                            year: year,
                            type: item.librarySource,
                            summary: summary.substring(0, 300)
                        });
                    }
                });

                // Failsafe
                if (filteredItems.length === 0) {
                    filteredItems = allItems.map(item => ({
                        title: item.title || "Unknown",
                        year: item.year || "Unknown",
                        type: item.librarySource,
                        summary: (item.summary || "").substring(0, 150)
                    }));
                }

                let catalog = filteredItems.sort(() => 0.5 - Math.random()).slice(0, 400);

                await statusMsg.edit(`📜 **Quest Theme:** \`${typeData.theme}\`\n✅ Netted ${catalog.length} highly relevant artifacts\n⏳ *The AI Game Master is writing your campaign...*`);

                // 3. THE QUEST BUILDER
                const questPrompt = `
                You are a charismatic Game Master charting a cinematic "Quest" (a media marathon) for a user.
                The core theme is: "${typeData.theme}"

                Analyze this catalog of media (JSON) and build a structured narrative journey.
                ${JSON.stringify(catalog)}

                CRITICAL RULES:
                1. You must select EXACTLY ${safeCount} items. NO MORE, NO LESS.
                2. Put them in a specific, logical watch order (e.g., escalating intensity, chronological by era, or thematic flow).
                3. For each stage, give it a cool "Stage Name" and write a 1-sentence narrative reason explaining why it is the perfect next step in the journey.

                Output ONLY a raw JSON object exactly like this:
                {
                  "questTitle": "A cool name for the overall marathon",
                  "introPitch": "A 1-sentence hype intro.",
                  "stages": [
                    {
                      "stageNum": 1,
                      "stageName": "The Setup",
                      "title": "Exact Media Title",
                      "year": "1999",
                      "narrative": "Why this kicks off the journey."
                    }
                  ]
                }
                `;

                const finalResult = await model.generateContent(questPrompt);
                const jsonMatch = finalResult.response.text().match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                const aiResponse = JSON.parse(jsonMatch[0]);

                await statusMsg.delete().catch(() => {});

                if (!aiResponse.stages || aiResponse.stages.length === 0) {
                    return msg.channel.send(`Yikes. I couldn't forge a quest out of the vault data. We might be missing the right artifacts for that specific journey.`);
                }

                // 4. THE REVEAL
                let reply = `🗺️ **QUEST ACCEPTED:** \`${aiResponse.questTitle}\`\n*${aiResponse.introPitch}*\n\n`;

                aiResponse.stages.forEach(stage => {
                    reply += `**Stage ${stage.stageNum}: ${stage.stageName}**\n`;
                    reply += `🎬 **${stage.title}** (${stage.year})\n`;
                    reply += `> *${stage.narrative}*\n\n`;
                });

                reply += `*(Total Quest Length: ${aiResponse.stages.length} Chapters)*`;

                await msg.channel.send(reply);

            } catch (err) {
                console.error(err);
                statusMsg.edit("❌ *My quill snapped while writing the quest lore. Try again!*").catch(() => {});
            }
        }
    }
};