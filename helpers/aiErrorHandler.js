/**
 * Centralized error handler for all Gemini AI commands.
 * This ensures we don't have to copy/paste 503 traffic spike logic into every single file!
 */
module.exports = function handleAIError(err, statusMsg, defaultErrorMessage) {
    console.error(err);

    const errorString = err.message ? err.message.toLowerCase() : "";

    // Handle Google Gemini Traffic Spikes
    if (errorString.includes("503") || errorString.includes("high demand") || errorString.includes("service unavailable")) {
        return statusMsg.edit("⚠️ *The AI servers are currently experiencing a massive traffic spike! Please wait a few moments and try again.*").catch(() => {});
    }

    // Handle Google Gemini Rate Limiting (Too many requests too fast)
    if (errorString.includes("429") || errorString.includes("quota")) {
        return statusMsg.edit("⚠️ *Whoa, slow down! We are sending too many requests to the AI at once. Give it a minute!*").catch(() => {});
    }

    // If it's a normal error, fall back to the specific minigame's custom error message
    return statusMsg.edit(defaultErrorMessage).catch(() => {});
};