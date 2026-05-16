// commands/buildcharacter.js
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const aiMapper = require('../helpers/aiCharacterMapper.js');
const compendium = require('../helpers/compendiumProvider.js');
const characterStorage = require('../helpers/characterStorage.js');
const logger = require('../helpers/logger.js');

function getStartingEquipment(className) {
    const gear = {
        'artificer': ['Light Crossbow', 'Studded Leather', 'Thieves\' Tools'],
        'barbarian': ['Greataxe', 'Handaxe', 'Explorer\'s Pack'],
        'bard': ['Rapier', 'Diplomat\'s Pack', 'Lute'],
        'cleric': ['Mace', 'Scale Mail', 'Priest\'s Pack', 'Shield'],
        'druid': ['Wooden Shield', 'Scimitar', 'Leather Armor'],
        'fighter': ['Longsword', 'Chain Mail', 'Dungeoneer\'s Pack'],
        'monk': ['Shortsword', 'Darts', 'Explorer\'s Pack'],
        'paladin': ['Longsword', 'Shield', 'Chain Mail'],
        'ranger': ['Longbow', 'Shortsword', 'Leather Armor'],
        'rogue': ['Rapier', 'Shortbow', 'Burglar\'s Pack', 'Thieves\' Tools'],
        'sorcerer': ['Light Crossbow', 'Dagger', 'Dungeoneer\'s Pack'],
        'warlock': ['Light Crossbow', 'Dagger', 'Scholar\'s Pack'],
        'wizard': ['Quarterstaff', 'Spellbook', 'Scholar\'s Pack']
    };
    return gear[className.toLowerCase()] || ['Dagger', 'Explorer\'s Pack', 'Bedroll'];
}

module.exports = {
  name: 'buildcharacter',
  command: {
    usage: '',
    description: 'Generates and saves a level 1 D&D character based on your Plex and Playnite habits.',
    process: async function(bot, client, message, query) {
      try {
        const waitMsg = await message.reply("🎲 Consulting the dimensional weave... (This might take a few seconds)");

        const userId = message.author.id;
        const profile = await aiMapper.determineClassProfile(userId);

        const charClass = compendium.getClass(profile.recommendedClass);
        const classFeatures = compendium.getClassFeaturesAtLevel(profile.recommendedClass, 1);

        const formattedFeatures = classFeatures.length > 0
            ? classFeatures.map(f => {
                const rawText = f.text ? (Array.isArray(f.text) ? f.text.join(' ') : f.text) : '';
                const trimmedText = rawText.length > 120 ? rawText.substring(0, 117) + '...' : rawText;
                return `**${f.name}**: ${trimmedText}`;
            }).join('\n\n')
            : '*No specific Level 1 active features.*';

        const baseItems = getStartingEquipment(profile.recommendedClass);
        const verifiedItems = baseItems.map(itemName => {
            const foundItems = compendium.searchItems(itemName);
            if (foundItems && foundItems.length > 0) {
                const item = foundItems.find(i => i.name.toLowerCase() === itemName.toLowerCase()) || foundItems[0];
                const weight = item.weight ? ` (${item.weight} lb)` : '';
                const dmg = item.dmg1 ? ` - *[${item.dmg1} dmg]*` : '';
                return `• **${item.name}**${weight}${dmg}`;
            }
            return `• **${itemName}**`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setColor('#D83C3E')
            .setTitle(`🎲 The Fates Have Decided!`)
            .setDescription(`**Assigned Class:** ${profile.recommendedClass}\n\n*"${profile.reasoning}"*`)
            .addFields(
                { name: 'Hit Dice', value: charClass && charClass.hd ? charClass.hd : 'Unknown', inline: true },
                { name: 'Proficiencies', value: charClass && charClass.proficiency ? charClass.proficiency : 'Unknown', inline: false },
                { name: 'Starting Equipment', value: verifiedItems, inline: false },
                { name: 'Starting Features', value: formattedFeatures, inline: false }
            )
            .setFooter({ text: 'Powered by Fight Club 5e Compendium & Gemini AI' });

        // Helper to finalize and save the data
        const finalizeAndSave = async (finalEmbed, cantripName = null) => {
            const characterData = {
                className: profile.recommendedClass,
                reasoning: profile.reasoning,
                hitDice: charClass ? charClass.hd : 'Unknown',
                equipment: verifiedItems,
                cantrip: cantripName
            };

            await characterStorage.saveCharacter(userId, characterData);
            await waitMsg.edit({ content: "✨ Your destiny is forged and recorded:", embeds: [finalEmbed], components: [] });
        };

        const magicClasses = ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard', 'artificer'];
        const isSpellcaster = magicClasses.includes(profile.recommendedClass.toLowerCase());

        if (!isSpellcaster) {
            await finalizeAndSave(embed);
            return;
        }

        const allCantrips = compendium.getSpellsByLevel(0);
        const classCantrips = allCantrips.filter(spell =>
            spell.classes && spell.classes.toLowerCase().includes(profile.recommendedClass.toLowerCase())
        ).slice(0, 25);

        if (classCantrips.length === 0) {
            await finalizeAndSave(embed);
            return;
        }

        const options = classCantrips.map(spell => ({
            label: spell.name,
            description: spell.school ? `School of ${spell.school}` : 'Cantrip',
            value: spell.name
        }));

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_cantrip')
                .setPlaceholder('Select a starting Cantrip...')
                .addOptions(options)
        );

        await waitMsg.edit({
            content: "✨ Your destiny is forged! As a magic user, choose your starting cantrip:",
            embeds: [embed],
            components: [row]
        });

        const filter = interaction => interaction.customId === 'select_cantrip' && interaction.user.id === message.author.id;
        const collector = waitMsg.createMessageComponentCollector({ filter, time: 60000 });

        collector.on('collect', async interaction => {
            // Acknowledge the interaction so Discord doesn't show "interaction failed"
            await interaction.deferUpdate();

            const selectedSpellName = interaction.values[0];
            const selectedSpell = classCantrips.find(s => s.name === selectedSpellName);

            const rawSpellText = selectedSpell.text ? (Array.isArray(selectedSpell.text) ? selectedSpell.text.join(' ') : selectedSpell.text) : 'No description provided.';
            const trimmedSpellText = rawSpellText.length > 250 ? rawSpellText.substring(0, 247) + '...' : rawSpellText;

            embed.addFields({ name: `Selected Cantrip: ${selectedSpell.name}`, value: trimmedSpellText, inline: false });

            // Save the finalized sheet including the cantrip
            await finalizeAndSave(embed, selectedSpell.name);
            collector.stop();
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                // If they time out, we save what we have without a cantrip
                finalizeAndSave(embed).catch(err => logger.error('buildcharacter finalize failed:', err));
            }
        });

      } catch (error) {
        logger.error('Error in buildcharacter command:', error);
        message.reply("The dimensional weave is unstable. I couldn't build your character right now.");
      }
    }
  }
};