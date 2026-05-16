// helpers/aiGameRecommender.js
// Recommends a game from the Playnite library based on a free-form user query.
// Uses the centralized getModel() so the API key and model name come from one source of truth.
const playniteAPI = require('./playniteAPI.js');
const logger = require('./logger.js');
const { getModel } = require('./geminiAPI.js');

class AIGameRecommender {
    constructor() {
        // Model is constructed lazily on first call so this module loads cleanly even when
        // geminiApiKey is empty — calls just fail at API time, caught by the existing handler.
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

    async recommendGame(userQuery) {
        try {
            const library = await playniteAPI.getLibrary();

            if (!library || library.error === 'OFFLINE') {
                throw new Error('Playnite API is offline or inaccessible.');
            }
            if (!Array.isArray(library) || library.length === 0) {
                throw new Error('Playnite returned an empty library.');
            }

            // Map the games using only the data the API actually provides; include install state
            // so the AI can prefer ready-to-play titles.
            const condensedLibrary = library.map(g => {
                const title = g.name || g.Name;
                if (!title) return null;
                const isInstalled = g.isInstalled === true || g.IsInstalled === true;
                return `• ${title} ${isInstalled ? '[INSTALLED]' : ''}`;
            }).filter(Boolean).join('\n');

            const prompt = this._buildPrompt(condensedLibrary, userQuery);

            logger.info(`Game recommender: evaluating ${library.length} games for "${userQuery}"`);

            const result = await this._getModel().generateContent(prompt);
            const responseText = result.response.text()
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();

            const parsedData = JSON.parse(responseText);

            if (!parsedData.title || !parsedData.reasoning) {
                throw new Error('AI returned incomplete JSON structure.');
            }

            return {
                title: parsedData.title,
                reasoning: parsedData.reasoning
            };
        } catch (error) {
            logger.error('Game recommender failed:', error.message || error);
            return {
                title: 'Matrix Error',
                reasoning: 'The AI was overwhelmed by the complexity of the query or the size of the library. Please try again.'
            };
        }
    }

    _buildPrompt(libraryData, userQuery) {
        return `
            You are an elite video game curator with vast internal knowledge of video game features, genres, hardware compatibility, and history.
            I am providing you with a massive list of games from a user's PC library. Some are marked [INSTALLED].

            USER'S LIBRARY:
            ${libraryData}

            THE USER'S REQUEST / KEYWORDS:
            "${userQuery}"

            INSTRUCTIONS:
            1. Use your internal knowledge of the gaming industry to evaluate the titles in the user's library.
            2. Find exactly ONE game that best matches their request. Prioritize games marked [INSTALLED] if possible, but it is not strictly required if an uninstalled game is a vastly superior match.
            3. If they asked for a "controller" game, ensure the game you pick is widely known to have excellent gamepad support.

            You must reply ONLY with a valid JSON object matching this exact schema:
            {
                "title": "Exact Game Title From The List",
                "reasoning": "A 2-sentence pitch explaining exactly why this game fits their request based on your knowledge of the game."
            }
        `;
    }
}

module.exports = new AIGameRecommender();
