// helpers/geminiAPI.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require('../config/config.js');

module.exports = {
    generateCharacterSheet: async function(username, stats, level, mode, existingSheet) {
        console.log(`\n[Gemini Debug] Starting generation request for: ${username}`);

        // DO NOT put your real API key in this next line! It checks for the placeholder text.
        if (!config.geminiApiKey || config.geminiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
            console.error("[Gemini Debug] CRITICAL: API Key is missing or still set to the default placeholder in config.js!");
            return null;
        }

        console.log("[Gemini Debug] API Key found. Initializing SDK...");
        const genAI = new GoogleGenerativeAI(config.geminiApiKey);

        // Using the specific preview model requested
        const model = genAI.getGenerativeModel({
            model: "gemini-3.1-pro-preview",
            generationConfig: {
                responseMimeType: "application/json"
            }
        });

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

        console.log(`[Gemini Debug] Sending payload to model. Mode: ${mode}, Level: ${level}`);

        try {
            const result = await model.generateContent(prompt);
            const rawText = result.response.text();

            console.log("[Gemini Debug] ✅ Response received successfully! Attempting to parse JSON...");
            console.log("[Gemini Debug] RAW AI OUTPUT:\n", rawText);

            return JSON.parse(rawText);
        } catch (err) {
            console.error("\n❌ ==== GEMINI API ERROR LOG ====");
            console.error("Error Name:", err.name);
            console.error("Error Message:", err.message);

            if (err.status) console.error("HTTP Status:", err.status);

            if (err.name === 'SyntaxError') {
                console.error("Reason: The AI model failed to return properly formatted JSON. Look at the raw output above to see what it messed up.");
            } else if (err.message.includes('API key not valid')) {
                console.error("Reason: Google rejected your API key. Make sure there are no spaces around it in config.js.");
            } else if (err.message.includes('fetch failed')) {
                console.error("Reason: Network issue. Your Node.js environment couldn't reach Google's servers.");
            } else if (err.message.includes('404') || err.message.includes('not found')) {
                console.error("Reason: The specific model version ('gemini-3.1-pro-preview') might not be accessible with your current key or region.");
            }

            console.error("Full Error Object:", err);
            console.error("=================================\n");
            return null;
        }
    }
};