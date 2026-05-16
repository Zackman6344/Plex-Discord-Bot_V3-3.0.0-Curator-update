// helpers/clueCache.js
//
// Persistent per-media clue cache for the AI minigames.
//
// One XML file per media item lives at data/clues/<slug>-<year>.xml. All minigames'
// generated clues for that media are stored side-by-side in the same file, with multiple
// variants per minigame supported for replay variety. Files are hand-editable.
//
// Randomness contract: the cache is consulted AFTER a minigame has independently picked
// its target. The cache never influences which media gets chosen — its only job is to
// avoid re-calling Gemini for clues we've already generated. This keeps the pool uniform
// regardless of which media happen to already be cached.

const fs = require('fs').promises;
const path = require('path');
const xml2js = require('xml2js');
const logger = require('./logger.js');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'clues');

// Parser options used with xml2js.parseStringPromise — calling the module-level function
// (not a reused Parser instance) avoids state-reuse issues across concurrent loads.
const XML_PARSER_OPTIONS = { explicitArray: false, mergeAttrs: false };
const XML_BUILDER = new xml2js.Builder({
    headless: false,
    renderOpts: { pretty: true, indent: '  ', newline: '\n' },
    xmldec: { version: '1.0', encoding: 'UTF-8' }
});

// Convert a free-form title into a filesystem-safe kebab-case slug.
function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 80) || 'untitled';
}

function cacheFilePath(media) {
    const slug = slugify(media && media.title);
    const year = (media && media.year) ? String(media.year) : 'unknown';
    return path.join(CACHE_DIR, `${slug}-${year}.xml`);
}

async function ensureCacheDir() {
    await fs.mkdir(CACHE_DIR, { recursive: true });
}

// Wrap xml2js's callback API in a promise so we don't depend on parseStringPromise
// (which was only added in xml2js 0.5+; the installed transitive version is older).
function parseXml(xml) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xml, XML_PARSER_OPTIONS, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

async function loadCacheFile(filePath) {
    try {
        const xml = await fs.readFile(filePath, 'utf8');
        return await parseXml(xml);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        logger.warn(`Failed to read clue cache at ${path.basename(filePath)}:`, err.message);
        return null;
    }
}

async function saveCacheFile(filePath, parsed) {
    await ensureCacheDir();
    const xml = XML_BUILDER.buildObject(parsed);
    await fs.writeFile(filePath, xml, 'utf8');
}

// xml2js with explicitArray:false collapses a single child into an object rather than
// a one-element array. This normalizer always returns an array so callers don't have
// to branch.
function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * Look up cached clues for (media, minigame). Returns a randomly-selected variant if any
 * exist, or null if there's no cached entry.
 *
 * The returned shape is: { data, generated, model, variantCount }
 *   - data         the original clue payload (whatever JSON the minigame produced)
 *   - generated    ISO timestamp when this variant was created
 *   - model        the Gemini model name used to generate it
 *   - variantCount how many variants were in the cache for picking context
 */
async function getCachedClues(media, minigame) {
    if (!media || !media.title) return null;
    const cache = await loadCacheFile(cacheFilePath(media));
    if (!cache || !cache.media || !cache.media.minigames) return null;

    const block = cache.media.minigames[minigame];
    if (!block) return null;

    const variants = asArray(block.variant);
    if (variants.length === 0) return null;

    const pick = variants[Math.floor(Math.random() * variants.length)];
    return {
        data: pick.data,
        generated: pick.generated,
        model: pick.model,
        variantCount: variants.length
    };
}

/**
 * Append a newly-generated set of clues to (media, minigame)'s cache. Idempotent on the
 * file — reads existing variants, adds the new one, writes back.
 */
async function saveClues(media, minigame, clueData, modelName) {
    if (!media || !media.title) return;
    const filePath = cacheFilePath(media);
    const existing = await loadCacheFile(filePath);

    const root = existing || {
        media: {
            title: media.title,
            year: media.year != null ? String(media.year) : '',
            type: media.type || '',
            plexKey: media.plexKey || '',
            minigames: {}
        }
    };

    if (!root.media.minigames) root.media.minigames = {};
    if (!root.media.minigames[minigame]) root.media.minigames[minigame] = { variant: [] };

    const block = root.media.minigames[minigame];
    block.variant = asArray(block.variant);
    block.variant.push({
        generated: new Date().toISOString(),
        model: modelName || '',
        data: clueData
    });

    await saveCacheFile(filePath, root);
}

/**
 * Convenience wrapper: check the cache for (media, minigame); on miss, run the generator
 * and save its result. The generator should return whatever clue object the minigame uses.
 *
 *   const clues = await clueCache.getOrGenerate(target, 'trivia', async () => {
 *     const ai = await model.generateContent(prompt);
 *     return JSON.parse(ai.response.text().match(/\{[\s\S]*\}/)[0]);
 *   }, DEFAULT_MODEL);
 */
async function getOrGenerate(media, minigame, generatorFn, modelName) {
    const cached = await getCachedClues(media, minigame);
    if (cached && cached.data) {
        logger.debug(`clueCache hit for ${minigame} "${media.title}" (${cached.variantCount} variants)`);
        return cached.data;
    }
    const fresh = await generatorFn();
    try {
        await saveClues(media, minigame, fresh, modelName);
        logger.debug(`clueCache miss for ${minigame} "${media.title}" — generated + saved`);
    } catch (err) {
        // Don't let a cache-write failure break the user's game.
        logger.warn(`clueCache write failed for ${minigame} "${media.title}":`, err.message || err);
    }
    return fresh;
}

module.exports = {
    getCachedClues,
    saveClues,
    getOrGenerate,
    // Exported for tests + advanced callers
    slugify,
    cacheFilePath,
    CACHE_DIR
};
