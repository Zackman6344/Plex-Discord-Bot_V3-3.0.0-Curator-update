// helpers/geminiAPI.js
// Single source of truth for the Gemini SDK + model instance.
// Change DEFAULT_MODEL to swap models for every AI command at once.
const { GoogleGenerativeAI } = require("@google/generative-ai");
const keys = require('../config/keys.js');
const logger = require('./logger.js');
const { inferReason } = require('./aiErrorHandler.js');

const DEFAULT_MODEL = "gemini-3.1-pro-preview";

let _genAI = null;
let _defaultModel = null;

function getGenAI() {
    if (!_genAI) {
        _genAI = new GoogleGenerativeAI(keys.geminiApiKey);
    }
    return _genAI;
}

// getModel()                                 -> shared default model
// getModel({ model: "gemini-2.5-pro" })      -> fresh instance with that model
// getModel({ generationConfig: {...} })      -> fresh instance with that config
// getModel({ model, generationConfig, ... }) -> fresh instance with everything passed through
function getModel(options) {
    const genAI = getGenAI();
    if (options && (options.model || options.generationConfig || options.systemInstruction || options.safetySettings)) {
        return genAI.getGenerativeModel({ model: options.model || DEFAULT_MODEL, ...options });
    }
    if (!_defaultModel) {
        _defaultModel = genAI.getGenerativeModel({ model: DEFAULT_MODEL });
    }
    return _defaultModel;
}

module.exports = {
    DEFAULT_MODEL,
    getGenAI,
    getModel,
    generateCharacterSheet: async function(username, stats, level, mode, existingSheet) {
        logger.info(`Starting Gemini character-sheet generation for ${username}`);

        // DO NOT put your real API key in this next line! It checks for the placeholder text.
        if (!keys.geminiApiKey || keys.geminiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
            logger.error("API Key is missing or still set to the default placeholder in keys.js");
            return null;
        }

        const model = getModel({ generationConfig: { responseMimeType: "application/json" } });

        let prompt = `You are an expert D&D 5e Dungeon Master. I am providing you with a player's video game playtime statistics (in minutes). Based on the games they play the most, generate a custom D&D 5e character profile for them.

Player Name: ${username}
Current Level: ${level}
Playtime Data: ${JSON.stringify(stats)}

Rules:
1. Choose a base D&D 5e class that matches the thematic vibe of their most played games.
2. Assign standard D&D stats (STR, DEX, CON, INT, WIS, CHA) prioritizing the attributes their games require.
3. Generate 2 completely custom, highly thematic feats inspired directly by their specific game history.
4. Write a 2-sentence flavorful backstory explaining how their gaming habits translate into this fantasy character's origins.
5. Return ONLY a raw JSON object matching the exact schema below. Do not include markdown blocks or any other text.`;

        if (mode === 'update' && existingSheet) {
            prompt += `\n\nUPDATE MODE: The player has requested an update. Here is their current sheet: ${JSON.stringify(existingSheet)}. Evolve their character. Keep their core class and identity, but update their backstory slightly to reflect their recent game history, and perhaps tweak a stat or a feat to show character growth.`;
        }

        const schema = `
{
  "class": "String",
  "alignment": "String",
  "stats": {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10},
  "feats": [{"name": "String", "description": "String"}],
  "backstory": "String"
}`;

        prompt += schema;

        logger.debug(`Sending Gemini payload. Mode: ${mode}, Level: ${level}`);

        try {
            const result = await model.generateContent(prompt);
            const rawText = result.response.text();

            logger.debug('Gemini raw output:', rawText);
            return JSON.parse(rawText);
        } catch (err) {
            const reason = inferReason(err);
            logger.error('Gemini character-sheet generation failed:', err.message || err, reason ? `(${reason})` : '');
            if (err.status) logger.error('HTTP status:', err.status);
            return null;
        }
    }
};
