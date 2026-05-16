// helpers/aiCharacterMapper.js
// Bridges a user's real-world gaming/media habits with the D&D compendium to suggest a class.
const compendiumProvider = require('./compendiumProvider.js');
const playniteAPI = require('./playniteAPI.js');
const tautulliAPI = require('./tautulliAPI.js');
const logger = require('./logger.js');
const { getModel } = require('./geminiAPI.js');

class AICharacterMapper {
    constructor() {
        // Lazy model construction — see aiGameRecommender for the same pattern + rationale.
        this._model = null;
    }

    _getModel() {
        if (!this._model) {
            this._model = getModel({
                generationConfig: {
                    temperature: 0.7,
                    responseMimeType: 'application/json'
                }
            });
        }
        return this._model;
    }

    /**
     * Analyzes user media habits and maps them to a D&D class.
     * @param {string} discordUserId
     * @returns {Promise<{ recommendedClass: string, reasoning: string }>}
     */
    async determineClassProfile(discordUserId) {
        try {
            // 1. Concurrent data aggregation. The shared tautulliAPI helper doesn't currently
            // expose per-user history; we just check it exists so a future getHistory() can plug in.
            const hasTautulliHistory = tautulliAPI && typeof tautulliAPI.getHistory === 'function';
            const [gameStats, mediaStats] = await Promise.allSettled([
                playniteAPI.getLibrary().catch(() => ({ error: 'OFFLINE' })),
                hasTautulliHistory
                    ? tautulliAPI.getHistory(discordUserId).catch(() => ({ error: 'OFFLINE' }))
                    : Promise.resolve({ error: 'NOT_IMPLEMENTED' })
            ]);

            const games = gameStats.status === 'fulfilled' && !gameStats.value.error ? gameStats.value : [];
            const media = mediaStats.status === 'fulfilled' && !mediaStats.value.error ? mediaStats.value : [];

            // 2. Compendium sync
            if (!compendiumProvider.isLoaded) {
                await compendiumProvider.initialize();
            }
            const availableClasses = compendiumProvider.classes.map(c => c.name);
            if (availableClasses.length === 0) {
                throw new Error('Compendium is empty or failed to load.');
            }

            // 3. Prompt + 4. AI invocation
            const prompt = this._buildPrompt(games, media, availableClasses);
            logger.info(`AI character mapper: evaluating profile for user ${discordUserId}`);
            const result = await this._getModel().generateContent(prompt);
            const parsedData = JSON.parse(result.response.text());

            // Verify the AI picked a class that actually exists in the compendium
            const finalClass = availableClasses.find(
                c => c.toLowerCase() === parsedData.recommendedClass.toLowerCase()
            );
            if (!finalClass) {
                logger.warn(`AI character mapper: hallucinated class rejected: ${parsedData.recommendedClass}`);
                return this._getFallback();
            }

            return {
                recommendedClass: finalClass,
                reasoning: parsedData.reasoning
            };
        } catch (error) {
            logger.error('AI character mapper failed:', error.message || error);
            return this._getFallback();
        }
    }

    _buildPrompt(games, media, availableClasses) {
        const gameTitles = Array.isArray(games) && games.length > 0
            ? games.slice(0, 15).map(g => g.name || g).join(', ')
            : 'No gaming data available';
        const mediaTitles = Array.isArray(media) && media.length > 0
            ? media.slice(0, 10).map(m => m.title || m).join(', ')
            : 'No media data available';

        return `
            You are a Dungeons & Dragons Dungeon Master analyzing a player's real-world media habits to assign them a starting D&D class.

            Player's Recently Played Video Games: ${gameTitles}
            Player's Recently Watched Movies/Shows: ${mediaTitles}

            Available D&D Classes (YOU MUST CHOOSE EXACTLY ONE FROM THIS LIST):
            [${availableClasses.join(', ')}]

            Evaluate their tastes. Do they prefer post-apocalyptic shooters (Artificer/Gunslinger), strategy and tower defense (Wizard/Tactician), or fantasy RPGs (Ranger/Paladin)?

            You must reply ONLY with a valid JSON object matching this exact schema:
            {
                "recommendedClass": "Exact Class Name From The List",
                "reasoning": "A 2-sentence fun, immersive explanation addressing the player as 'you', referencing their specific games or movies as justification for this class."
            }
        `;
    }

    _getFallback() {
        return {
            recommendedClass: 'Fighter',
            reasoning: 'The dimensional weave is clouded right now, so we are relying on reliable steel. You are a Fighter.'
        };
    }
}

module.exports = new AICharacterMapper();
