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
    name: 'curate',
    command: {
        usage: '!curate',
        description: 'Start an interactive session with the AI media curator',
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

            // Added 'intent' to track whether the AI is filtering or answering trivia
            let session = {
                catalog: [],
                currentPool: [],
                matches: [],
                currentIndex: 0,
                conversationHistory: "",
                intent: "filter"
            };

            const openingQuestion = "I'm ready to dig into the archives. \n\n**First, specify the library:** (Movies, TV Shows, or Music?)\n**Next, describe the exact vibe:** (e.g., 'A gritty wasteland survival story', 'A fantasy world with deep lore', or 'Chill background music'.)";
            await msg.channel.send(`🤖 **The Curator:** ${openingQuestion}`);

            const filter = m => m.author.id === msg.author.id;
            const collector = msg.channel.createMessageCollector({ filter, time: 180000 });

            collector.on('collect', async m => {
                collector.resetTimer();
                const userInput = m.content.trim();
                const userInputLower = userInput.toLowerCase();

                if (userInputLower === 'stop' || userInputLower === 'cancel' || userInputLower === 'exit') {
                    collector.stop();
                    return msg.channel.send("Curator session closed. Enjoy the watch!");
                }

                if (userInputLower === 'next' || userInputLower === 'more') {
                    if (session.matches.length === 0) {
                        return msg.channel.send("We don't have any matches yet. Tell me what vibe you're looking for first!");
                    }

                    session.currentIndex += 3;
                    if (session.currentIndex >= session.matches.length) {
                        return msg.channel.send("We've reached the end of the current matches. Ask a question, filter further, or type 'stop'.");
                    }

                    // Force the list to show if they specifically asked for the next page
                    return sendRecommendations(msg.channel, session, true);
                }

                session.conversationHistory += `\nUser: ${userInput}`;
                let statusMsg = await msg.channel.send("🔍 **Curator Search Initializing...**");

                try {
                    if (session.catalog.length === 0) {
                        await statusMsg.edit("🔍 **Curator Status:**\n⏳ *Decoding mood and casting a massive keyword net...*");

// THE UPGRADE: Bulletproof Library Classification
                        const typePrompt = `
                        Based on the user's exact request: "${userInput}"
                        1. Determine the library type. You MUST choose one of these exact three strings: "movie", "show", or "artist".
                           - If they ask for movies, films, or cinema -> "movie"
                           - If they ask for tv, shows, series, or episodes -> "show"
                           - If they ask for music, songs, tracks, albums, bands, or audio -> "artist"
                        2. Generate an EXHAUSTIVE array of keywords, tropes, themes, and synonyms to help search a database for this vibe.

                        CRITICAL RULES:
                        - Keep going until you cannot think of any more keywords.
                        - STRICT ANCHORING: Every single keyword MUST connect DIRECTLY back to the user's original request. Do NOT make second-degree associative leaps.

                        Output ONLY a raw JSON object exactly like this:
                        {"type": "artist", "keywords": ["word1", "word2", "word3"]}
                        `;
                        const typeResult = await model.generateContent(typePrompt);
                        const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                        const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { type: "movie", keywords: [] };

                        await statusMsg.edit(`🔍 **Curator Status:**\n✅ Mood decoded (${typeData.type})\n✅ Massive net cast with **${typeData.keywords.length} direct keywords**\n⏳ *Connecting to The Nerdgasm Plex server...*`);

                        const sections = await plex.query('/library/sections');
                        const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === typeData.type);

                        if (!targetSection) {
                            await statusMsg.delete();
                            return msg.channel.send(`Couldn't find a library section for ${typeData.type}s!`);
                        }

// THE FIX: Append ?type=10 to force Plex to return Songs instead of Artists
                        let queryUrl = `/library/sections/${targetSection.key}/all`;
                        if (targetSection.type === 'artist') {
                            queryUrl += `?type=10`;
                        }

                        const libraryData = await plex.query(queryUrl);
                        const allItems = libraryData.MediaContainer.Metadata || [];

                        await statusMsg.edit(`🔍 **Curator Status:**\n✅ Mood decoded\n✅ Connected to Plex\n⏳ *Sifting through all ${allItems.length} server files...*`);

                        let filteredItems = [];
                        const lowerKeywords = typeData.keywords.map(k => k.toLowerCase());

                        allItems.forEach(item => {
                            let title = item.title || "Unknown Title";
                            let summary = item.summary || "";
                            let year = item.year || item.parentYear || "Unknown";

                            // THE FIX: Inject artist/album data so the AI has context to read
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

                        session.catalog = filteredItems.slice(0, 5000);
                        session.currentPool = session.catalog;

                        await statusMsg.edit(`🔍 **Curator Status:**\n✅ Mood decoded\n✅ Connected to Plex\n✅ **Netted ${session.catalog.length} highly relevant files**\n⏳ *AI is cross-referencing plot summaries...*`);
                    } else {
                        // General update for follow-ups (since it could be filtering or trivia)
                        await statusMsg.edit(`🔍 **Curator Status:**\n⏳ *Analyzing your input...*`);
                    }

                    const isFollowUp = session.matches.length > 0;

// THE FIX: Uncapped Match Generation
                    const taskDescription = isFollowUp
                        ? `Determine if the user is asking to FILTER the list further, or asking a QUESTION/TRIVIA about the media.
                           - If FILTERING: Return intent "filter" and update the matches.
                           - If a QUESTION (e.g., "who directed it?", "tell me about the second one"): Return intent "question", answer them thoroughly with cool facts, and leave matches empty.`
                        : `Analyze this catalog and return ALL highly relevant titles that match the request. Do not arbitrarily cap your results—if there are 60 matches, list all 60. Return intent "filter". Think broadly.`;

                    const curatorPrompt = `
                    You are an expert media curator and trivia master. Keep responses engaging and conversational.
                    Context: ${session.conversationHistory}

                    Task: ${taskDescription}

                    Current Pool to analyze (JSON):
                    ${JSON.stringify(session.currentPool)}

                    Output ONLY a raw JSON object (no markdown, no extra text) exactly like this:
                    {
                      "intent": "filter" or "question",
                      "message": "Your conversational reply. If a question, provide fascinating trivia. If filtering, ask a follow-up question.",
                      "matches": [
                        {"title": "Exact Title", "year": "2024", "pitch": "A punchy, 1-sentence reason why it fits."}
                      ]
                    }
                    `;

                    const finalResult = await model.generateContent(curatorPrompt);

                    const jsonMatch = finalResult.response.text().match(/\{[\s\S]*\}/);
                    if (!jsonMatch) throw new Error("Failed to parse AI JSON response");

                    const aiResponse = JSON.parse(jsonMatch[0]);

                    session.intent = aiResponse.intent || "filter";
                    session.lastMessage = aiResponse.message || "What do you think?";

                    // Only update the pool and matches if the AI was explicitly told to filter
                    if (session.intent === 'filter') {
                        if (aiResponse.matches && aiResponse.matches.length > 0) {
                            session.matches = aiResponse.matches;
                            session.currentIndex = 0;

                            session.currentPool = session.currentPool.filter(poolItem =>
                                session.matches.some(match => match.title === poolItem.title)
                            );
                        } else {
                            session.matches = [];
                        }
                    }

                    await statusMsg.delete().catch(() => {});

                    if (session.intent === 'filter' && session.matches.length === 0) {
                        return msg.channel.send(`Ah, you filtered a bit too hard! I couldn't find anything left in the pool that fits that exact description. Let's back up a step. ${session.lastMessage}`);
                    }

                    // Send the final results (pass 'false' because we only force-show matches on 'next')
                    sendRecommendations(msg.channel, session, false);

                } catch (err) {
                    console.error("Session Error:", err);
                    await statusMsg.edit("❌ *I hit a snag trying to process that. Let's try again. (Try typing 'stop' to restart)*").catch(() => {});
                }
            });

            collector.on('end', () => {
                session = null;
            });
        }
    }
};

// THE UPGRADE: Dynamic UX Presentation
async function sendRecommendations(channel, session, forceShowMatches) {
    let reply = `🤖 **The Curator:** ${session.lastMessage}\n\n`;

    // Only print the list of movies if we are filtering, OR if the user typed 'next'
    if (session.intent === 'filter' || forceShowMatches) {
        const total = session.matches.length;
        const currentMatches = session.matches.slice(session.currentIndex, session.currentIndex + 3);

        reply += `🎯 **Current Matches (${total} total):**\n\n`;
        currentMatches.forEach(rec => {
            reply += `🎬 **${rec.title}** (${rec.year})\n> ${rec.pitch}\n\n`;
        });
    }

    let footer = `\n*(Type **'next'** to see more, **'stop'** to exit, or just chat with me about the media!)*`;

    await channel.send(reply + footer);
}
