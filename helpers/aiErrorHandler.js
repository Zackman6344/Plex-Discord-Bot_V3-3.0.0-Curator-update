/**
 * Centralized error handling for Gemini AI commands.
 *
 * inferReason(err)
 *   Returns a user-facing string explaining the most likely cause of `err`,
 *   or null if no specific pattern matched. Pure function — no I/O.
 *
 * handleAIError(err, statusMsg, defaultErrorMessage)
 *   Logs the error and edits `statusMsg` with the inferred reason if one was
 *   found, otherwise the command-specific defaultErrorMessage.
 */
const logger = require('./logger.js');

function inferReason(err) {
    const msg = (err && err.message) ? err.message.toLowerCase() : '';

    if (msg.includes('503') || msg.includes('high demand') || msg.includes('service unavailable')) {
        return '⚠️ *The AI servers are experiencing a traffic spike. Try again in a moment.*';
    }
    if (msg.includes('429') || msg.includes('quota')) {
        return '⚠️ *Rate limited — too many requests in a short window. Give it a minute and retry.*';
    }
    if (msg.includes('api key not valid') || msg.includes('api_key_invalid')) {
        return '❌ *Gemini rejected the API key. Check `config/keys.js` for stray spaces or an expired key.*';
    }
    if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('econnrefused')) {
        return '❌ *Network issue — could not reach Google.*';
    }
    if (msg.includes('404') || msg.includes('not found')) {
        return '❌ *The configured Gemini model isn\'t accessible. Check `DEFAULT_MODEL` in `helpers/geminiAPI.js`.*';
    }
    if (err && err.name === 'SyntaxError') {
        return '❌ *The AI returned malformed JSON. Try again or simplify your input.*';
    }
    return null;
}

function handleAIError(err, statusMsg, defaultErrorMessage) {
    logger.error('AI command failed:', err);
    const reply = inferReason(err) || defaultErrorMessage;
    return statusMsg.edit(reply).catch(() => {});
}

module.exports = handleAIError;
module.exports.inferReason = inferReason;
