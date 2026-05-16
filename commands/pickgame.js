// commands/pickgame.js
const { EmbedBuilder } = require('discord.js');
const aiRecommender = require('../helpers/aiGameRecommender.js');
const logger = require('../helpers/logger.js');

module.exports = {
  name: 'pickgame',
  command: {
    usage: '<keywords/mood>',
    description: 'Searches your Playnite library using AI to find a game matching your requested keywords or hardware.',
    process: async function(bot, client, message, query) {
      try {
        // If the user just typed "!pickgame" with no arguments, default to a random great game
        const userQuery = query || "anything highly rated or fun";

        const waitMsg = await message.reply(`🎮 Casting the keyword net for: *"${userQuery}"*...`);

        const recommendation = await aiRecommender.recommendGame(userQuery);

        if (recommendation.title === "Error") {
            return waitMsg.edit(recommendation.reasoning);
        }

        const embed = new EmbedBuilder()
                    .setColor('#7289DA')
                    .setTitle(`🎮 Your Next Adventure Awaits!`)
                    .setDescription(`**Recommended Game:** ${recommendation.title}\n\n*"${recommendation.reasoning}"*`)
                    .addFields({ name: 'Your Request', value: `*${userQuery}*`, inline: false }) // <-- Fixed Line
                    .setFooter({ text: 'Powered by Playnite & Gemini AI' });

        await waitMsg.edit({ content: "Found a match in your library:", embeds: [embed] });

      } catch (error) {
        logger.error('Error in pickgame command:', error);
        message.reply("The curation matrix crashed. Try again later.");
      }
    }
  }
};