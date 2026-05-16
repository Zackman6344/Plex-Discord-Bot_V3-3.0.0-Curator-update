const { EmbedBuilder } = require('discord.js');
const characterStorage = require('../helpers/characterStorage.js');
const logger = require('../helpers/logger.js');
const compendium = require('../helpers/compendiumProvider.js');

module.exports = {
  name: 'mysheet',
  command: {
    usage: '[@user]',
    description: 'Displays your or a mentioned user\'s currently saved D&D character sheet.',
    process: async function(bot, client, message, query) {
      try {
        // 1. Determine target user (Author or Mentioned User)
        const targetUser = message.mentions.users.first() || message.author;
        const userId = targetUser.id;

        // 2. Retrieve the saved character from the local JSON storage
        const savedData = await characterStorage.getCharacter(userId);

        // 3. Handle missing sheet dynamically
        if (!savedData || !savedData.sheet) {
            if (targetUser.id === message.author.id) {
                return message.reply("You don't have a saved character yet! Run the `buildcharacter` command first to forge your destiny.");
            } else {
                return message.reply(`${targetUser.username} hasn't forged their destiny yet. Tell them to run \`buildcharacter\`!`);
            }
        }

        const sheet = savedData.sheet;

        // 4. Dynamically pull the Level 1 features
        const classFeatures = compendium.getClassFeaturesAtLevel(sheet.className, 1);
        const formattedFeatures = classFeatures.length > 0
            ? classFeatures.map(f => {
                const rawText = f.text ? (Array.isArray(f.text) ? f.text.join(' ') : f.text) : '';
                const trimmedText = rawText.length > 120 ? rawText.substring(0, 117) + '...' : rawText;
                return `**${f.name}**: ${trimmedText}`;
            }).join('\n\n')
            : '*No specific Level 1 active features.*';

        // 5. Reconstruct the UI Embed
        const embed = new EmbedBuilder()
            .setColor('#D83C3E')
            .setTitle(`🛡️ ${targetUser.username}'s Character Sheet`)
            .setDescription(`**Class:** ${sheet.className}\n\n*"${sheet.reasoning}"*`)
            .addFields(
                { name: 'Hit Dice', value: sheet.hitDice || 'Unknown', inline: true },
                { name: 'Starting Equipment', value: sheet.equipment || 'None recorded', inline: false },
                { name: 'Starting Features', value: formattedFeatures, inline: false }
            );

        if (sheet.cantrip) {
            embed.addFields({ name: 'Chosen Cantrip', value: `• **${sheet.cantrip}**`, inline: false });
        }

        embed.setFooter({ text: `Sheet generated on: ${new Date(savedData.updatedAt).toLocaleDateString()}` });

        await message.reply({ embeds: [embed] });

      } catch (error) {
        logger.error('Error in mysheet command:', error);
        message.reply("The archives are currently inaccessible. Please try again later.");
      }
    }
  }
};