// commands/profile.js
const fs = require('fs');
const path = require('path');
const { MessageEmbed } = require('discord.js');
const gemini = require('../helpers/geminiAPI.js');
const playnite = require('../helpers/playniteAPI.js');
const config = require('../config/config.js');

const statsFilePath = path.join(__dirname, '..', 'playtime_stats.json');
const sheetsFilePath = path.join(__dirname, '..', 'character_sheets.json');

// Standard D&D 5e XP Thresholds
const xpThresholds = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

module.exports = {
    name: 'profile',
    command: {
        usage: '!profile [update/regen]',
        description: 'Generates your AI-crafted D&D character sheet based on gaming history.',
        process: async function(bot, client, msg) {
            if (!msg) return;

            const userId = msg.author.id;
            const isOwner = userId === config.ownerId;
            const args = msg.content.split(' ').slice(1);
            const modeArg = args[0] ? args[0].toLowerCase() : null;

            let userGames = {};
            let totalHours = 0;
            let initialStatusMsg = null;

            // 1. DATA GATHERING: The Master User vs Normal Users
            if (isOwner && config.playniteEnabled) {
                initialStatusMsg = await msg.channel.send("🔍 *Accessing host database... Fetching lifetime Playnite records...*");
                const playniteStats = await playnite.getStats();

                if (!playniteStats || playniteStats.error === 'OFFLINE') {
                    return initialStatusMsg.edit("❌ **Playnite is offline!** Cannot read the master record.");
                }

                // Playnite tracks in seconds, so we convert to hours for XP, and minutes for the AI
                totalHours = Math.floor(playniteStats.TotalPlaytime / 3600);

                if (playniteStats.TopGames) {
                    playniteStats.TopGames.forEach(g => {
                        userGames[g.Name] = Math.floor(g.Playtime / 60);
                    });
                }
            } else {
                // Read from the Discord Tracker for friends
                if (!fs.existsSync(statsFilePath)) return msg.channel.send("❌ No gaming data found. The tracker needs to see you play something first!");
                const playtimeData = JSON.parse(fs.readFileSync(statsFilePath, 'utf8'));

                if (!playtimeData[userId] || !playtimeData[userId].games) {
                    return msg.channel.send("❌ You don't have any recorded playtime yet! Boot up a game first.");
                }

                userGames = playtimeData[userId].games;
                let totalMinutes = 0;
                for (const game in userGames) totalMinutes += userGames[game];
                totalHours = Math.floor(totalMinutes / 60);
            }

            // 2. Calculate D&D Level (1 Hour = 100 XP)
            const totalXP = totalHours * 100;
            let level = 1;
            for (let i = 0; i < xpThresholds.length; i++) {
                if (totalXP >= xpThresholds[i]) level = i + 1;
                else break;
            }
            if (level > 20) level = 20; // Level cap

            // 3. Check for existing sheets
            let sheetsData = {};
            if (fs.existsSync(sheetsFilePath)) {
                sheetsData = JSON.parse(fs.readFileSync(sheetsFilePath, 'utf8'));
            }

            const hasExistingSheet = !!sheetsData[userId];

            if (hasExistingSheet && modeArg && modeArg !== 'update' && modeArg !== 'regen') {
                if (initialStatusMsg) await initialStatusMsg.delete().catch(()=>{});
                return msg.channel.send("⚠️ You already have a character sheet! Type `!profile update` to evolve it, or `!profile regen` for a new one.");
            }

            let finalSheet = null;

            // 4. GENERATION LOGIC WITH GEMINI
            if (!hasExistingSheet || modeArg === 'regen') {
                const text = "🎲 *Rolling the dice... Gemini is crafting a new character based on your game library...*";
                if (initialStatusMsg) await initialStatusMsg.edit(text);
                else initialStatusMsg = await msg.channel.send(text);

                finalSheet = await gemini.generateCharacterSheet(msg.author.username, userGames, level, 'new', null);
            }
            else if (modeArg === 'update') {
                const text = "📜 *Consulting the Dungeon Master... Gemini is evolving your character...*";
                if (initialStatusMsg) await initialStatusMsg.edit(text);
                else initialStatusMsg = await msg.channel.send(text);

                finalSheet = await gemini.generateCharacterSheet(msg.author.username, userGames, level, 'update', sheetsData[userId].sheet);
            }
            else {
                // Load from cache
                finalSheet = sheetsData[userId].sheet;
                if (initialStatusMsg) await initialStatusMsg.delete().catch(()=>{});
            }

            if (!finalSheet && (modeArg === 'update' || modeArg === 'regen' || !hasExistingSheet)) {
                return initialStatusMsg.edit("❌ **Error:** The AI Dungeon Master fumbled the roll. Please ensure the Gemini API key is valid.");
            }

            // Save the newly minted/updated sheet to the hard drive
            if (modeArg === 'update' || modeArg === 'regen' || !hasExistingSheet) {
                sheetsData[userId] = {
                    username: msg.author.username,
                    level: level,
                    lastUpdated: Date.now(),
                    sheet: finalSheet
                };
                fs.writeFileSync(sheetsFilePath, JSON.stringify(sheetsData, null, 2));
            }

            // 5. BUILD THE EMBED
            const s = finalSheet.stats;
            const statsString = `**STR:** ${s.STR} | **DEX:** ${s.DEX} | **CON:** ${s.CON} | **INT:** ${s.INT} | **WIS:** ${s.WIS} | **CHA:** ${s.CHA}`;

            let featsString = "";
            finalSheet.feats.forEach(feat => {
                featsString += `**${feat.name}:** ${feat.description}\n\n`;
            });

            const embed = new MessageEmbed()
                .setColor('#D4AF37')
                .setTitle(`🛡️ ${msg.author.username} - Level ${level} ${finalSheet.class}`)
                .setDescription(`*${finalSheet.alignment}*\n\n**Total XP:** ${totalXP.toLocaleString()} / ${level < 20 ? xpThresholds[level].toLocaleString() : 'MAX'}`)
                .addField('📊 Base Stats', statsString, false)
                .addField('✨ Custom Feats', featsString, false)
                .addField('📖 Backstory', finalSheet.backstory, false);

            // Tailor the footer based on the data source
            if (isOwner) {
                embed.setFooter({ text: 'Data: Lifetime Playnite Library | AI: Gemini 3.1 Pro' });
            } else {
                embed.setFooter({ text: 'Data: Server Tracker | AI: Gemini 3.1 Pro | Use !profile update to evolve' });
            }

            if (initialStatusMsg && (modeArg === 'update' || modeArg === 'regen' || !hasExistingSheet)) {
                await initialStatusMsg.edit({ content: " ", embeds: [embed] });
            } else {
                await msg.channel.send({ embeds: [embed] });
            }
        }
    }
};