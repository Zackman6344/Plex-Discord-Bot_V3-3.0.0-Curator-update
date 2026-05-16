// helpers/characterStorage.js
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger.js');

/**
 * Principal Engineer Note: This service manages the persistent storage of
 * character sheets. It uses a local JSON file to avoid external database overhead.
 * Defensive checks ensure the data directory and file exist before writing.
 */
class CharacterStorage {
    constructor() {
        this.dirPath = path.join(__dirname, '..', 'data');
        this.filePath = path.join(this.dirPath, 'characters.json');
    }

    /**
     * Initializes the storage file if it doesn't exist.
     */
    async _ensureStorageExists() {
        try {
            await fs.mkdir(this.dirPath, { recursive: true });
            try {
                await fs.access(this.filePath);
            } catch {
                // File doesn't exist, create an empty array
                await fs.writeFile(this.filePath, JSON.stringify([], null, 2), 'utf8');
            }
        } catch (error) {
            logger.error('Character storage init failed:', error.message);
        }
    }

    /**
     * Saves or overwrites a user's character sheet.
     * @param {string} userId - Discord User ID
     * @param {Object} characterData - The generated sheet data
     */
    async saveCharacter(userId, characterData) {
        await this._ensureStorageExists();

        try {
            const data = await fs.readFile(this.filePath, 'utf8');
            let characters = JSON.parse(data);

            const newRecord = {
                userId: userId,
                updatedAt: new Date().toISOString(),
                sheet: characterData
            };

            // Check if user already has a saved character, overwrite if they do
            const existingIndex = characters.findIndex(c => c.userId === userId);
            if (existingIndex >= 0) {
                characters[existingIndex] = newRecord;
            } else {
                characters.push(newRecord);
            }

            await fs.writeFile(this.filePath, JSON.stringify(characters, null, 2), 'utf8');
            return true;
        } catch (error) {
            logger.error('Failed to save character to disk:', error.message);
            return false;
        }
    }

    /**
     * Retrieves a saved character by Discord User ID.
     * @param {string} userId
     * @returns {Object|null}
     */
    async getCharacter(userId) {
        await this._ensureStorageExists();

        try {
            const data = await fs.readFile(this.filePath, 'utf8');
            const characters = JSON.parse(data);
            return characters.find(c => c.userId === userId) || null;
        } catch (error) {
            logger.error('Failed to read character from disk:', error.message);
            return null;
        }
    }
}

module.exports = new CharacterStorage();