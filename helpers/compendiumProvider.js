// helpers/compendiumProvider.js
const fs = require('fs').promises;
const path = require('path');
const xml2js = require('xml2js');
const logger = require('./logger.js');

/**
 * Principal Engineer Note: This unified provider reads the raw XML compendium
 * on bot startup, converts it to JSON in memory, and provides safe getter
 * methods for your Discord commands to use without reading from the disk again.
 */
class CompendiumProvider {
    constructor() {
        this.classes = [];
        this.spells = [];
        this.items = [];
        this.isLoaded = false;
    }

    /**
     * Reads the XML file, parses it, and structures the data into memory.
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        try {
            logger.info('Loading and parsing FightClub5e XML compendium...');

            // Adjust this path if your XML is stored elsewhere
            const xmlPath = path.join(__dirname, '..', 'compendium', 'FightClub5e.xml');
            const xmlData = await fs.readFile(xmlPath, 'utf8');

            // xml2js's parseStringPromise only exists on 0.5+; the transitive version
            // shipped here is older, so wrap the callback API in a promise.
            const result = await new Promise((resolve, reject) => {
                xml2js.parseString(xmlData, { explicitArray: false, mergeAttrs: true }, (err, r) => {
                    if (err) reject(err);
                    else resolve(r);
                });
            });

            const compendium = result.compendium;
            if (!compendium) {
                throw new Error("Invalid XML format: Missing <compendium> root tag.");
            }

            // 1. Extract and clean Classes
            this.classes = this._ensureArray(compendium.class).map(c => ({
                name: c.name,
                hd: c.hd,
                proficiency: c.proficiency,
                features: this._ensureArray(c.autolevel)
            }));

            // 2. Extract Spells & Items
            this.spells = this._ensureArray(compendium.spell);
            this.items = this._ensureArray(compendium.item);

            this.isLoaded = true;
            logger.info(`Compendium loaded: ${this.classes.length} classes, ${this.spells.length} spells, ${this.items.length} items.`);
            return true;

        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.error('Compendium XML file not found. Place FightClub5e.xml in the compendium/ folder.');
            } else {
                logger.error('Compendium parse failed:', error.message || error);
            }
            return false;
        }
    }

    /**
     * Helper to ensure single XML nodes are treated as arrays.
     */
    _ensureArray(item) {
        if (!item) return [];
        return Array.isArray(item) ? item : [item];
    }

    /**
     * Retrieves a specific class by name.
     * @param {string} className
     * @returns {Object|null}
     */
    getClass(className) {
        if (!this.isLoaded) throw new Error("CompendiumProvider not initialized.");
        const targetName = className.toLowerCase();
        return this.classes.find(c => c.name.toLowerCase() === targetName) || null;
    }

    /**
     * Retrieves all features for a class at a specific level.
     * @param {string} className
     * @param {number|string} level
     * @returns {Array} Array of feature objects
     */
    getClassFeaturesAtLevel(className, level) {
        const charClass = this.getClass(className);
        if (!charClass || !charClass.features) return [];

        const targetLevel = String(level);
        return charClass.features.filter(feature => String(feature.level) === targetLevel);
    }

    /**
     * Retrieves all spells of a specific level (0 for Cantrips).
     * @param {number|string} level
     * @returns {Array}
     */
    getSpellsByLevel(level) {
        if (!this.isLoaded) throw new Error("CompendiumProvider not initialized.");
        const targetLevel = String(level);
        return this.spells.filter(s => String(s.level) === targetLevel);
    }

    /**
     * Searches items by a fuzzy name match.
     * @param {string} query
     * @returns {Array}
     */
    searchItems(query) {
        if (!this.isLoaded) throw new Error("CompendiumProvider not initialized.");
        if (!query || query.length < 2) return [];

        const q = query.toLowerCase();
        return this.items.filter(i => i.name.toLowerCase().includes(q));
    }
}

module.exports = new CompendiumProvider();