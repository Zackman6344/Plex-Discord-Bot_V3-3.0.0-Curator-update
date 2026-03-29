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
    name: 'identify',
    command: {
        usage: '!identify',
        description: 'An interactive detective wizard to decode a vague memory of a piece of media.',
        process: async function(...args) {
            let msg = null;

            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg && typeof arg === 'object' && (arg.channel || arg.author)) {
                    msg = arg;
                }
            }

            if (!msg) return console.error("Critical Error: Could not locate the Discord message object!");

            const affirmitiveWords = ['yes', 'y', 'yeah', 'yep', 'vault', 'sure', 'i think so'];
            const negativeWords = ['no', 'n', 'nope', 'nah', 'wrong'];

            let ans1 = await promptUser(msg.channel, msg.author.id, `🕵️ **Detective Mode Standby!**\n<@${msg.author.id}>, before I start digging, are you sure you saw this on **The Nerdgasm**?\n\n*(Reply with **Yes** to only search our server, or **No** to search all of existence)*`);

            if (!ans1) return msg.channel.send("🕵️ *Case suspended. You took too long to answer! Run `!identify` to try again.*");
            let vaultOnly = affirmitiveWords.includes(ans1.toLowerCase());

            let isSearching = true;
            let targetText = vaultOnly ? "our server" : "the global archives";
            let promptText = `Got it. We are searching **${targetText}**.\n\nNow, tell me what you remember. Give me your most vague, chaotic description!`;

            while (isSearching) {
                let rawInput = await promptUser(msg.channel, msg.author.id, promptText);

                if (!rawInput) return msg.channel.send("🕵️ *Case suspended. You took too long to give a description!*");
                if (rawInput.toLowerCase() === 'cancel' || rawInput.toLowerCase() === 'stop') return msg.channel.send("🕵️ *Investigation aborted.*");

                let statusMsg = await msg.channel.send(`🔍 **Detective Mode Activated...**\n⏳ *Decoding your vague memory...*`);

                try {
                    if (vaultOnly) {
                        await statusMsg.edit(`🔍 **Detective Mode [VAULT RESTRICTED]**\n⏳ *Casting a keyword net over The Nerdgasm...*`);

                        const typePrompt = `
                        The user is vaguely describing media: "${rawInput}"
                        1. Determine the library type: "movie", "show", or "artist".
                        2. Generate an EXHAUSTIVE array of keywords, tropes, themes, and synonyms to help search a database for this description.
                        Output ONLY a raw JSON object exactly like this:
                        {"type": "movie", "keywords": ["word1", "word2"]}
                        `;

                        const typeResult = await model.generateContent(typePrompt);
                        const typeMatch = typeResult.response.text().match(/\{[\s\S]*\}/);
                        const typeData = typeMatch ? JSON.parse(typeMatch[0]) : { type: "movie", keywords: [] };

                        const sections = await plex.query('/library/sections');
                        const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === typeData.type) || sections.MediaContainer.Directory.find(sec => sec.type === 'movie');

                        let queryUrl = `/library/sections/${targetSection.key}/all`;
                        if (targetSection && targetSection.type === 'artist') queryUrl += `?type=10`;

                        const libraryData = await plex.query(queryUrl);
                        const allItems = libraryData.MediaContainer.Metadata || [];

                        await statusMsg.edit(`🔍 **Detective Mode [VAULT RESTRICTED]**\n✅ Netted ${typeData.keywords.length} keywords\n⏳ *Sifting through the server files...*`);

                        let filteredItems = [];
                        const lowerKeywords = typeData.keywords.map(k => k.toLowerCase());

                        allItems.forEach(item => {
                            let title = item.title || "";
                            let summary = item.summary || "";
                            if (targetSection && targetSection.type === 'artist') {
                                title = `${title} by ${item.grandparentTitle || "Unknown Artist"}`;
                            }

                            const lowerTitle = title.toLowerCase();
                            const lowerSummary = summary.toLowerCase();
                            const hasMatch = lowerKeywords.some(keyword => lowerTitle.includes(keyword) || lowerSummary.includes(keyword));

                            if (hasMatch || lowerKeywords.length === 0) {
                                filteredItems.push({
                                    title: title,
                                    year: item.year || item.parentYear || "Unknown",
                                    summary: summary.substring(0, 150)
                                });
                            }
                        });

                        // THE UPGRADE: The Dynamic Overload Tripwire
                        if (filteredItems.length === 0) {
                            await statusMsg.delete().catch(() => {});
                            promptText = `🕵️ **Case Cold:** Your description didn't trigger a single match in the vault! Are you sure it's on here?\n\nTry giving me a completely different description, or type **Cancel** to stop.`;
                            continue; // Loops back up to ask for a new description
                        }

                        const SAFETY_LIMIT = 400; // The absolute maximum items sent to AI
                        if (filteredItems.length > SAFETY_LIMIT) {
                            await statusMsg.delete().catch(() => {});
                            promptText = `🕵️ **Whoa there!** That description was so broad it flagged **${filteredItems.length}** possible suspects. My AI brain would melt trying to process all of that at once!\n\nCould you give me a slightly more specific description to narrow it down? (Or type **Cancel** to stop)`;
                            continue; // Loops back up to ask for a new description
                        }

                        // If it passes the safety check, use EVERYTHING that was filtered
                        let catalog = filteredItems;

                        await statusMsg.edit(`🔍 **Detective Mode [VAULT RESTRICTED]**\n✅ Filtered down to a pool of ${catalog.length} suspects\n⏳ *The AI is building its first profile...*`);

                        const identifyPrompt = `
                        You are an expert pop-culture detective. The user is trying to remember a piece of media they saw IN THIS SPECIFIC CATALOG based on this vague description:
                        "${rawInput}"

                        Catalog (JSON):
                        ${JSON.stringify(catalog)}

                        1. Identify the exact media FROM THE CATALOG ABOVE that best matches the description.
                        2. If absolutely nothing in the catalog matches even slightly, set "identified" to false.

                        Output ONLY a raw JSON object exactly like this:
                        {
                            "identified": true,
                            "title": "Exact Title from Catalog",
                            "year": "2002",
                            "pitch": "A 1-sentence summary.",
                            "trivia": "A cool piece of behind-the-scenes trivia."
                        }
                        `;

                        const aiResult = await model.generateContent(identifyPrompt);
                        const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                        if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                        const aiData = JSON.parse(jsonMatch[0]);
                        await statusMsg.delete().catch(() => {});

                        if (!aiData.identified) {
                            promptText = `🕵️ **Case Cold:** I scoured the remaining ${catalog.length} suspects, but absolutely nothing matches. Are you sure you saw it here?\n\nDo you want to try a new description? (Or type **Cancel** to stop)`;
                            continue;
                        }

                        let reply = `🎯 **First Suspect Identified!** Is this it?\n\n`;
                        reply += `🎬 **${aiData.title}** (${aiData.year})\n`;
                        reply += `> ${aiData.pitch}\n\n`;
                        reply += `*(Reply with **Yes** or **No**)*`;

                        let isRightAns = await promptUser(msg.channel, msg.author.id, reply);
                        if (!isRightAns) return msg.channel.send("🕵️ *Case suspended. You vanished!*");

                        if (affirmitiveWords.includes(isRightAns.toLowerCase())) {
                            await msg.channel.send("😎 **Case closed.** Grab the popcorn!");
                            isSearching = false;
                        } else {
                            await msg.channel.send(`🕵️ *Plot twist! Alright, let's narrow this down. I'll ask some questions. Just reply with **Yes**, **No**, or **Unsure**.*`);

                            let playing20Q = true;
                            let currentCatalog = catalog;
                            let history = `Initial description: "${rawInput}". First guess was "${aiData.title}" (User confirmed this was INCORRECT).`;

                            while (playing20Q) {
                                let thinkingMsg = await msg.channel.send(`🧠 *Reviewing the remaining ${currentCatalog.length} suspects...*`);

                                const qPrompt = `
                                You are an expert pop-culture detective playing 20 Questions to find a piece of media on a Plex server.

                                Conversation History:
                                ${history}

                                Remaining Suspects in the Vault (JSON):
                                ${JSON.stringify(currentCatalog)}

                                INSTRUCTIONS:
                                1. Filter the "Remaining Suspects" list. REMOVE titles that contradict the "Conversation History". Keep ones that fit the "Yes" answers and don't violate the "No" answers.
                                2. If the filtered list has 0 items, set action to "empty".
                                3. If the filtered list has exactly 1 item left, or you are extremely confident in one item, set action to "guess". DO NOT guess a title you have already guessed.
                                4. If the filtered list has multiple items, set action to "ask". Generate a strategic Yes/No question that will eliminate about half of the remaining suspects. DO NOT repeat questions.

                                Output ONLY a raw JSON object exactly like this:
                                {
                                    "filteredCatalog": [{"title": "...", "year": "...", "summary": "..."}],
                                    "action": "ask" | "guess" | "empty",
                                    "text": "The Yes/No question to ask, OR the pitch for your guess if guessing.",
                                    "guessTitle": "The exact title if action is guess (otherwise null)"
                                }
                                `;

                                let aiGameResult = await model.generateContent(qPrompt);
                                let gameMatch = aiGameResult.response.text().match(/\{[\s\S]*\}/);
                                if (!gameMatch) throw new Error("Failed to parse AI 20Q JSON");

                                let gameData = JSON.parse(gameMatch[0]);
                                currentCatalog = gameData.filteredCatalog || [];

                                await thinkingMsg.delete().catch(()=>{});

                                if (gameData.action === 'empty' || currentCatalog.length === 0) {
                                    let restartAns = await promptUser(msg.channel, msg.author.id, `🕵️ **Case Cold:** I've eliminated every single suspect in the vault based on your answers! There is nothing left that matches.\n\nDo you want to restart the search from the beginning with a new description? *(Yes / No)*`);
                                    if (!restartAns) return;

                                    if (affirmitiveWords.includes(restartAns.toLowerCase())) {
                                        playing20Q = false;
                                        promptText = `Got it. Let's start fresh. Give me your new vague description!`;
                                    } else {
                                        await msg.channel.send("🕵️ *Case suspended. Let me know if you remember anything else!*");
                                        playing20Q = false;
                                        isSearching = false;
                                    }
                                } else if (gameData.action === 'guess') {
                                    let guessAns = await promptUser(msg.channel, msg.author.id, `🎯 **I think I got it!** Is it **${gameData.guessTitle}**?\n> ${gameData.text}\n\n*(Yes / No)*`);
                                    if (!guessAns) return;

                                    if (affirmitiveWords.includes(guessAns.toLowerCase())) {
                                        await msg.channel.send("😎 **Boom. Case closed.** Enjoy the watch!");
                                        playing20Q = false;
                                        isSearching = false;
                                    } else {
                                        history += `\nGuessed: "${gameData.guessTitle}" -> User said No.`;
                                    }
                                } else {
                                    let userAns = await promptUser(msg.channel, msg.author.id, `🕵️ **Question:** ${gameData.text}\n*(Yes / No / Unsure)*`);
                                    if (!userAns) return;
                                    history += `\nAsked: "${gameData.text}" -> User answered: "${userAns}".`;
                                }
                            }
                        }

                    } else {
                        // ==========================================
                        // PATH B: THE GLOBAL SEARCH (Non-Interactive)
                        // ==========================================
                        const identifyPrompt = `
                        You are an expert pop-culture detective. The user is trying to remember a piece of media based on this vague description:
                        "${rawInput}"

                        1. Identify the exact media (movie, TV show, or musical artist/band) from all of existence.
                        2. Provide a fascinating piece of behind-the-scenes trivia about it.
                        3. If the description is absolute nonsense, set "identified" to false.

                        Output ONLY a raw JSON object exactly like this:
                        {
                            "identified": true,
                            "title": "Exact Official Title",
                            "year": "2002",
                            "type": "movie",
                            "pitch": "A 1-sentence summary of what it actually is.",
                            "trivia": "A cool piece of behind-the-scenes trivia."
                        }
                        `;

                        const aiResult = await model.generateContent(identifyPrompt);
                        const jsonMatch = aiResult.response.text().match(/\{[\s\S]*\}/);
                        if (!jsonMatch) throw new Error("Failed to parse AI JSON");

                        const aiData = JSON.parse(jsonMatch[0]);

                        if (!aiData.identified) {
                            await statusMsg.delete().catch(() => {});
                            promptText = `🕵️ **Case Cold:** I dug through the global archives, but your description is just too vague. I have no idea what that is!\n\nDo you want to try a new description? (Or type **Cancel** to stop)`;
                            continue;
                        }

                        await statusMsg.edit(`🔍 **Detective Mode:**\n✅ Identified as **${aiData.title}** (${aiData.year})\n⏳ *Checking The Nerdgasm vault to see if we have it...*`);

                        const sections = await plex.query('/library/sections');
                        let targetType = aiData.type;
                        if (targetType !== 'movie' && targetType !== 'show' && targetType !== 'artist') targetType = 'movie';
                        const targetSection = sections.MediaContainer.Directory.find(sec => sec.type === targetType);

                        let isOwned = false;

                        if (targetSection) {
                            let queryUrl = `/library/sections/${targetSection.key}/all`;
                            if (targetSection.type === 'artist') queryUrl += `?type=10`;

                            const libraryData = await plex.query(queryUrl);
                            const allItems = libraryData.MediaContainer.Metadata || [];

                            const cleanString = (str) => str.toLowerCase().replace(/[^\w\s]/g, '');
                            const targetTitle = cleanString(aiData.title);

                            const foundItem = allItems.find(item => {
                                let itemTitle = item.title || "";
                                if (targetSection.type === 'artist') itemTitle = item.grandparentTitle || itemTitle;
                                return cleanString(itemTitle) === targetTitle || cleanString(itemTitle).includes(targetTitle);
                            });

                            if (foundItem) isOwned = true;
                        }

                        await statusMsg.delete().catch(() => {});

                        let reply = `🎯 **Target Identified!** You are thinking of:\n\n`;
                        reply += `🎬 **${aiData.title}** (${aiData.year})\n`;
                        reply += `> ${aiData.pitch}\n\n`;
                        reply += `🧠 **Trivia:** *${aiData.trivia}*\n\n`;

                        if (isOwned) {
                            reply += `✅ **Vault Status:** Good news! **${aiData.title}** is currently sitting in The Nerdgasm vault ready to watch.`;
                        } else {
                            reply += `❌ **Vault Status:** Bad news! We don't have this one in the archives yet. You might have to put in a request for it.`;
                        }

                        await msg.channel.send(reply);
                        isSearching = false;
                    }

                } catch (err) {
                    console.error(err);
                    statusMsg.edit("❌ *My brain short-circuited trying to decode that memory. Try again!*").catch(() => {});
                    isSearching = false;
                }
            }
        }
    }
};