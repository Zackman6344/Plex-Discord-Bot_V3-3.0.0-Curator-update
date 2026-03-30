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

// Prevent multiple campaigns running in the same channel at once
const activeGames = new Set();

module.exports = {
    name: 'survive',
    command: {
        usage: '!survive',
        description: 'Open the Main Menu for the Survive the Scene campaign.',
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

            const rawInput = commandArgs.join(" ").trim().toLowerCase();
            const words = rawInput.split(" ");
            const firstWord = words[0];
            const channelId = msg.channel.id;

            // ==========================================
            // MAIN MENU & SETUP
            // ==========================================
            if (!firstWord || firstWord === 'menu' || firstWord === 'help') {
                const menuText = `
🩸 **Survive the Scene - Main Menu** 🩸
*The AI drops you into a random movie or show from the server. Tell it what you do to survive.*

**Difficulties:**
🟢 **Easy:** 1 Scene, 1 Judgment. Survive the inciting incident.
🟡 **Medium:** 2 Scenes, 2 Judgments. Make it past the first act.
🔴 **Hard:** 3 Scenes, 3 Judgments. Survive into the meat of the story.
🟣 **Expert:** 4 Scenes, 4 Judgments. Reach the climax.
⚫ **Nightmare:** 5 Scenes, 5 Judgments. Beat the entire plot!

**Commands:**
▶️ \`!survive start easy\`
▶️ \`!survive start medium\`
▶️ \`!survive start hard\`
▶️ \`!survive start expert\`
▶️ \`!survive start nightmare\`
                `;
                return msg.channel.send(menuText.trim());
            }

            // Parse the command arguments
            let difficulty = "easy";
            let maxRounds = 1;

            const applyDifficulty = (diffString) => {
                if (diffString === 'nightmare') { difficulty = "nightmare"; maxRounds = 5; return true; }
                if (diffString === 'expert') { difficulty = "expert"; maxRounds = 4; return true; }
                if (diffString === 'hard') { difficulty = "hard"; maxRounds = 3; return true; }
                if (diffString === 'medium') { difficulty = "medium"; maxRounds = 2; return true; }
                if (diffString === 'easy') { difficulty = "easy"; maxRounds = 1; return true; }
                return false;
            };

            if (firstWord === 'start') {
                const diffArg = words[1] || 'easy';
                if (!applyDifficulty(diffArg)) {
                    return msg.channel.send("⚠️ *Please specify a valid difficulty (easy/medium/hard/expert/nightmare).*");
                }
            } else if (!applyDifficulty(firstWord)) {
                return msg.channel.send("⚠️ *Unknown command. Type \`!survive\` to see the Main Menu!*");
            }

            // Prevent overlapping games
            if (activeGames.has(channelId)) {
                return msg.channel.send("⚠️ *A survival scenario is already running in this channel! Please wait for it to finish.*");
            }

            activeGames.add(channelId);

            let statusMsg = await msg.channel.send(`🎲 **Setting the Stage (${difficulty.toUpperCase()})...**\n⏳ *Finding a dangerous situation in the Plex vault...*`);

            try {
                const sections = await plex.query('/library/sections');
                const validSections = sections.MediaContainer.Directory.filter(sec => sec.type === 'movie' || sec.type === 'show');

                if (validSections.length === 0) {
                    return statusMsg.edit(`❌ I couldn't find any Movie or TV Show libraries!`);
                }

                const randomSection = validSections[Math.floor(Math.random() * validSections.length)];

                await statusMsg.edit(`🎲 **Setting the Stage (${difficulty.toUpperCase()})...**\n⏳ *Targeting the ${randomSection.title} library...*`);

                const libraryData = await plex.query(`/library/sections/${randomSection.key}/all`);
                const allItems = libraryData.MediaContainer.Metadata || [];

                let target = null;
                let attempts = 0;
                while (!target && attempts < 50) {
                    let randomItem = allItems[Math.floor(Math.random() * allItems.length)];
                    if (randomItem.summary && randomItem.summary.length > 50 && randomItem.title) {
                        target = randomItem;
                    }
                    attempts++;
                }

                if (!target) return statusMsg.edit(`❌ I couldn't find a scenario with enough plot detail!`);

                const targetType = target.type === 'show' ? 'TV Show' : 'Movie';
                await statusMsg.delete().catch(() => {});

                // ==========================================
                // THE GAME LOOP (Handles 1 to 5 Rounds)
                // ==========================================
                let survivingPlayers = new Set(); // Stores Discord User IDs
                let isFirstRound = true;

                for (let currentRound = 1; currentRound <= maxRounds; currentRound++) {

                    let loadingPromptMsg = await msg.channel.send(`⏳ *The AI Game Master is writing Scene ${currentRound}...*`);

                    // 1. GENERATE THE SCENARIO (Dynamic based on round)
                    let scenarioPrompt = "";
                    if (isFirstRound) {
                        scenarioPrompt = `
                        You are a Game Master for a "Survive the Scene" Discord game.
                        The secret ${targetType} is: "${target.title}" (${target.year || "Unknown Year"}).
                        Official Synopsis: "${target.summary}"

                        Write a highly atmospheric, 2nd-person prompt (using "You") that drops the players directly into the inciting incident or main danger of this plot.
                        Do NOT use the title or obvious character names. Make it sound dangerous, mysterious, or urgent.
                        End the prompt by explicitly asking: "**What do you do?**"

                        Output ONLY a raw JSON object exactly like this:
                        { "scenario": "Your 3-4 sentence atmospheric setup..." }
                        `;
                    } else {
                        scenarioPrompt = `
                        You are a Game Master for a "Survive the Scene" Discord game.
                        The secret ${targetType} is: "${target.title}" (${target.year || "Unknown Year"}).
                        Official Synopsis: "${target.summary}"

                        The players have just survived the previous danger in the plot. Move the story forward to the NEXT major scene, obstacle, twist, or the climax.
                        Write a highly atmospheric, 2nd-person prompt dropping the remaining survivors into this new situation.
                        Do NOT use the title or obvious character names.
                        End the prompt by explicitly asking: "**What do you do next?**"

                        Output ONLY a raw JSON object exactly like this:
                        { "scenario": "Your 3-4 sentence atmospheric setup..." }
                        `;
                    }

                    const scenarioResult = await model.generateContent(scenarioPrompt);
                    const scenarioMatch = scenarioResult.response.text().match(/\{[\s\S]*\}/);
                    if (!scenarioMatch) throw new Error("Failed to parse AI Scenario JSON");
                    const scenarioData = JSON.parse(scenarioMatch[0]);

                    await loadingPromptMsg.delete().catch(() => {});

                    // 2. COLLECT PLAYER ACTIONS
                    let headerText = isFirstRound ? `🚨 **SURVIVE THE SCENE! (Round 1/${maxRounds})** 🚨\n*Anyone can join! You have 60 seconds to type your action.*` : `🚨 **SCENE ${currentRound}/${maxRounds}** 🚨\n*Only the survivors may act! You have 60 seconds.*`;
                    await msg.channel.send(`${headerText}\n\n${scenarioData.scenario}`);

                    const filter = m => !m.author.bot && !m.content.startsWith('!') && (isFirstRound || survivingPlayers.has(m.author.id));

                    const collectedMessages = await msg.channel.awaitMessages({ filter, time: 60000 });

                    if (collectedMessages.size === 0) {
                        await msg.channel.send(`🕰️ **TIME'S UP!** 🕰️\nNobody reacted in time! You all stood perfectly still and perished.\n\n**GAME OVER.**\nThe scenario was from: 🎬 **${target.title}** (${target.year})`);
                        return;
                    }

                    let judgmentMsg = await msg.channel.send(`🕰️ **TIME'S UP! Actions locked.** 🕰️\n⏳ *The Game Master is evaluating your choices...*`);

                    // 3. EVALUATE THE ACTIONS
                    let actionList = "";
                    collectedMessages.forEach(m => {
                        actionList += `Player ${m.author.id} (${m.author.username}): "${m.content}"\n`;
                        m.react('👀').catch(() => {});
                    });

                    const judgmentPrompt = `
                    You are the Game Master judging player actions based on the plot of the ${targetType}: "${target.title}".
                    Official Synopsis: "${target.summary}"

                    Based strictly on the themes, logic, and dangers of "${target.title}", decide if each player's action allows them to SURVIVE this specific scene or if they DIE.
                    Be slightly ruthless but fair. If they do something stupid that would get them killed in this specific movie/show, they die.

                    Here are the players and their actions:
                    ${actionList}

                    Output ONLY a raw JSON object containing an array of results. Use "survive" or "die" for the outcome. Provide a funny, 1-sentence reason for their fate.
                    {
                        "results": [
                            {
                                "userId": "ID_HERE",
                                "username": "NAME_HERE",
                                "outcome": "survive or die",
                                "reason": "Your 1-sentence funny explanation."
                            }
                        ]
                    }
                    `;

                    const judgmentResult = await model.generateContent(judgmentPrompt);
                    const jsonMatch = judgmentResult.response.text().match(/\{[\s\S]*\}/);
                    if (!jsonMatch) throw new Error("Failed to parse AI Judgment JSON");
                    const judgmentData = JSON.parse(jsonMatch[0]);

                    // 4. PROCESS RESULTS & UPDATE SURVIVORS
                    let nextRoundSurvivors = new Set();
                    let roundReport = `🎬 **Judgment (Scene ${currentRound}/${maxRounds})**\n`;

                    judgmentData.results.forEach(res => {
                        if (res.outcome.toLowerCase() === 'survive') {
                            roundReport += `🟢 **${res.username} LIVED:** ${res.reason}\n`;
                            nextRoundSurvivors.add(res.userId);
                        } else {
                            roundReport += `💀 **${res.username} DIED:** ${res.reason}\n`;
                        }
                    });

                    survivingPlayers = nextRoundSurvivors;
                    isFirstRound = false;

                    if (currentRound === maxRounds) {
                        roundReport += `\n🎉 **THE END!**\nYou were trapped in: **${target.title}** (${target.year}). `;
                        if (survivingPlayers.size > 0) {
                            roundReport += `Congratulations to the final survivors!`;
                        } else {
                            roundReport += `Sadly, nobody made it to the credits.`;
                        }
                        await judgmentMsg.edit(roundReport);
                    } else {
                        if (survivingPlayers.size === 0) {
                            roundReport += `\n❌ **TOTAL PARTY WIPE!**\nNobody survived the scene. The game ends here!\nYou were trapped in: 🎬 **${target.title}** (${target.year})`;
                            await judgmentMsg.edit(roundReport);
                            return;
                        } else {
                            roundReport += `\n⚠️ *The survivors press forward... prepare for the next scene!*`;
                            await judgmentMsg.edit(roundReport);
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }
                    }
                }

            } catch (err) {
                handleAIError(err, statusMsg, "❌ *The AI director walked off set. Try again!*");
            } finally {
                // Always unlock the channel when the game is completely over
                activeGames.delete(channelId);
            }
        }
    }
};