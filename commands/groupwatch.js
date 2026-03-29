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

module.exports = {
    name: 'groupwatch',
    command: {
        usage: '!groupwatch',
        description: 'Start a 60-second group vote to find a compromise for media night',
        process: async function(...args) {
            let msg = null;
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object') {
                    if (arg.channel && typeof arg.channel.send === 'function') { msg = arg; break; }
                    if (typeof arg.reply === 'function' && arg.author) { msg = arg; break; }
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            // STAGE 1: Ask the initiator for the library
            await msg.channel.send(`🍿 **Group Watch Setup!** 🍿\n<@${msg.author.id}>, before I start the timer, which library are we diving into? (e.g., Movies, TV Shows, or Music)`);

            const setupFilter = m => m.author.id === msg.author.id;
            const setupCollector = msg.channel.createMessageCollector({ filter: setupFilter, time: 45000, max: 1 });

            setupCollector.on('collect', async m1 => {
                const userLibraryRequest = m1.content.trim();

                // STAGE 2: Open the floor to the group
                await msg.channel.send(`⏱️ **Group Watch Activated!** ⏱️\nTarget: **${userLibraryRequest}**\n\nEveryone (including <@${msg.author.id}>) has **60 seconds** to throw their desired vibe, genre, constraint, or media reference into the ring. (e.g., 'Make it scary', 'Something like Game of Thrones').\n\n*Timer starts now! Type your requests!*`);

                const groupFilter = m => !m.author.bot;
                const groupCollector = msg.channel.createMessageCollector({ filter: groupFilter, time: 60000 });
                const userRequests = new Map();

                groupCollector.on('collect', m => {
                    if (m.content.startsWith('!')) return;

                    if (userRequests.has(m.author.username)) {
                        const existing = userRequests.get(m.author.username);
                        userRequests.set(m.author.username, existing + ". AND ALSO: " + m.content);
                    } else {
                        userRequests.set(m.author.username, m.content);
                    }

                    m.react('👀').catch(() => {});
                });

                groupCollector.on('end', async collected => {
                    if (userRequests.size === 0) {
                        return msg.channel.send("Nobody chimed in! Group Watch cancelled.");
                    }

                    let statusMsg = await msg.channel.send("⏳ *Time's up! The Curator is decoding everyone's demands...*");

                    try {
                        let combinedPrompt = "";
                        userRequests.forEach((vibe, user) => {
                            combinedPrompt += `- **${user}** wants: "${vibe}"\n`;
                        });

                        const typePrompt = `
                        The user asked to search this library: "${userLibraryRequest}".
                        Determine the library type. You MUST choose one of these exact three strings: "movie", "show", or "artist".
                        - Movies, films, cinema -> "movie"
                        - TV, shows, series -> "show"
                        - Music, songs, tracks, audio -> "artist"

                        Then, analyze these group demands:
                        ${combinedPrompt}

                        1. DECODE REFERENCES: If anyone asked for something "like" a specific movie/show/game, extract the core themes, tropes, and vibes of that media.
                        2. GENERATE NET: Create an EXHAUSTIVE array of keywords, genres, and synonyms that cover ALL of these diverse demands to help search a database.

                        Output ONLY a raw JSON object exactly like this:
                        {"type": "movie", "keywords": ["word1", "word2", "word3"]}
                        `;

                        const typeResult = await model.generateContent(typePrompt);
                        const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                        const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { type: "movie", keywords: [] };

                        await statusMsg.edit(`🔍 **Curator Status:**\n✅ Vibes collected & references decoded\n✅ Massive net cast with **${typeData.keywords.length} keywords**\n⏳ *Connecting to The Nerdgasm Plex server...*`);

                        const sections = await plex.query('/library/sections');
                        const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === typeData.type);

                        if (!targetSection) {
                            return statusMsg.edit(`❌ Couldn't find a library section for ${typeData.type}s!`);
                        }

                        let queryUrl = `/library/sections/${targetSection.key}/all`;
                        if (targetSection.type === 'artist') {
                            queryUrl += `?type=10`;
                        }

                        const libraryData = await plex.query(queryUrl);
                        const allItems = libraryData.MediaContainer.Metadata || [];

                        await statusMsg.edit(`🔍 **Curator Status:**\n✅ Vibes & references decoded\n✅ Connected to Plex\n⏳ *Sifting through all ${allItems.length} server files...*`);

                        let filteredItems = [];
                        const lowerKeywords = typeData.keywords.map(k => k.toLowerCase());

                        allItems.forEach(item => {
                            let title = item.title || "Unknown Title";
                            let summary = item.summary || "";
                            let year = item.year || item.parentYear || "Unknown";

                            if (targetSection.type === 'artist') {
                                const artist = item.grandparentTitle || "Unknown Artist";
                                const album = item.parentTitle || "Unknown Album";
                                title = `${title} by ${artist}`;
                                if (!summary) summary = `A song by ${artist} from the album ${album}.`;
                            }

                            const lowerTitle = title.toLowerCase();
                            const lowerSummary = summary.toLowerCase();

                            const hasMatch = lowerKeywords.some(keyword => lowerTitle.includes(keyword) || lowerSummary.includes(keyword));
                            if (hasMatch || lowerKeywords.length === 0) {
                                filteredItems.push({
                                    title: title,
                                    year: year,
                                    summary: summary.substring(0, 300)
                                });
                            }
                        });

                        if (filteredItems.length === 0) {
                            filteredItems = allItems.map(item => {
                                let title = item.title || "Unknown Title";
                                if (targetSection.type === 'artist') title = `${title} by ${item.grandparentTitle || "Unknown Artist"}`;
                                return { title: title, year: item.year || "Unknown", summary: item.summary || "No summary." };
                            });
                        }

                        let catalog = filteredItems.sort(() => 0.5 - Math.random()).slice(0, 5000);

                        await statusMsg.edit(`🔍 **Curator Status:**\n✅ Connected to Plex\n✅ Netted ${catalog.length} highly relevant items\n⏳ *Drafting the ultimate compromise...*`);

                        const curatorPrompt = `
                        You are a mediator and media curator. A group of people are trying to pick something to enjoy together, but they have conflicting requests.

                        Here are their demands:
                        ${combinedPrompt}

                        Analyze this catalog (JSON) and find up to 3 titles that best satisfy everyone's constraints simultaneously. Get creative with the compromise.
                        ${JSON.stringify(catalog)}

                        CRITICAL INSTRUCTION FOR THE PITCH:
                        Your pitch must explicitly explain your logic. Name the users and explain exactly HOW this title merges their conflicting vibes.

                        Output ONLY a raw JSON object exactly like this:
                        {
                          "matches": [
                            {"title": "Exact Title", "year": "2024", "pitch": "The explanation of how it bridges the gap between the specific users."}
                          ]
                        }
                        `;

                        const finalResult = await model.generateContent(curatorPrompt);
                        const jsonMatch = finalResult.response.text().match(/\{[\s\S]*\}/);
                        if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                        const aiResponse = JSON.parse(jsonMatch[0]);

                        await statusMsg.delete().catch(() => {});

                        if (!aiResponse.matches || aiResponse.matches.length === 0) {
                            return msg.channel.send(`Yikes. Your requests were too wildly different! I couldn't find a single thing that fits all of those demands. Someone is going to have to compromise.`);
                        }

                        let reply = `🎯 **Group Watch Compromise Found!** Here is my logic:\n\n`;
                        aiResponse.matches.forEach(rec => {
                            reply += `🎬 **${rec.title}** (${rec.year})\n> ${rec.pitch}\n\n`;
                        });

                        // STAGE 3: The QA Afterparty
                        let qaFooter = `\n*(I'm hanging around for a bit! If anyone has questions about these picks, just type **\`?\`** followed by your question, like \`?Who directed the first one?\`)*`;
                        await msg.channel.send(reply + qaFooter);

                        // Set up the listener for the QA window
                        const qaFilter = m => !m.author.bot && m.content.startsWith('?');
                        const qaCollector = msg.channel.createMessageCollector({ filter: qaFilter, time: 120000 }); // 2 minute idle timer

                        // Save context for the AI so it knows what it just recommended
                        const qaContext = `Group Demands: ${combinedPrompt}\nRecommended Titles:\n${JSON.stringify(aiResponse.matches)}`;

                        qaCollector.on('collect', async qaMsg => {
                            // THE FIX: Reset the 2-minute timer every time someone asks a question
                            qaCollector.resetTimer();

                            let question = qaMsg.content.slice(1).trim();
                            if (!question) return;

                            let thinkingMsg = await qaMsg.channel.send(`🧠 *Checking my notes...*`);

                            try {
                                const qaPrompt = `
                                You are a media expert. You just recommended these titles to a group:
                                ${qaContext}

                                User "${qaMsg.author.username}" is asking: "${question}"

                                Answer their question concisely and engagingly. Include fun trivia if relevant. Do not use markdown code blocks or JSON, just write a conversational response.
                                `;

                                const qaResult = await model.generateContent(qaPrompt);
                                await thinkingMsg.edit(`🤖 **The Curator:** ${qaResult.response.text()}`);
                            } catch (e) {
                                console.error(e);
                                await thinkingMsg.edit("❌ *Sorry, my brain glitched while looking that up!*");
                            }
                        });

                        qaCollector.on('end', () => {
                            msg.channel.send("🍿 *The Curator's QA window has closed due to inactivity. Enjoy your watch!*");
                        });

                    } catch (err) {
                        console.error(err);
                        statusMsg.edit("❌ *I hit a snag trying to calculate that compromise.*").catch(() => {});
                    }
                });
            });

            setupCollector.on('end', collected => {
                if (collected.size === 0) {
                    msg.channel.send("Setup timed out. Run `!groupwatch` to try again.");
                }
            });
        }
    }
};