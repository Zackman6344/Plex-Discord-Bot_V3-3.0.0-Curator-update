// helpers/tautulliAPI.js
const config = require('../config/config.js');

module.exports = {
    getLibraryStats: async function() {
        try {
            if (!config.tautulliEnabled || !config.tautulliApiKey) return null;

            // Ping libraries for the movie/show counts, and ping history for the total stream count
            const libUrl = `${config.tautulliUrl}/api/v2?apikey=${config.tautulliApiKey}&cmd=get_libraries`;

            // length=1 ensures we just get the grand total number without downloading your entire server history
            const histUrl = `${config.tautulliUrl}/api/v2?apikey=${config.tautulliApiKey}&cmd=get_history&length=1`;

            const [libResponse, histResponse] = await Promise.all([
                fetch(libUrl, { signal: AbortSignal.timeout(5000) }),
                fetch(histUrl, { signal: AbortSignal.timeout(5000) })
            ]);

            if (!libResponse.ok || !histResponse.ok) throw new Error("Tautulli API failed.");

            const libJson = await libResponse.json();
            const histJson = await histResponse.json();

            let movieCount = 0;
            let showCount = 0;

            // Tally up the media
            if (libJson.response.data) {
                libJson.response.data.forEach(lib => {
                    if (lib.section_type === 'movie') movieCount += parseInt(lib.count || 0);
                    if (lib.section_type === 'show') showCount += parseInt(lib.count || 0);
                });
            }

            return {
                movies: movieCount,
                shows: showCount,
                // recordsTotal is Tautulli's master variable for every stream ever played
                streams: histJson.response.data.recordsTotal || 0
            };

        } catch (err) {
            console.error("Tautulli API Connection Failed:", err.message);
            return null;
        }
    }
};