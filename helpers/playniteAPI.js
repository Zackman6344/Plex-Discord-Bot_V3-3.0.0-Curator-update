// helpers/playniteAPI.js
module.exports = {
    getLibrary: async function() {
        try {
            // Adds a strict 5000ms timeout
            const response = await fetch('http://localhost:8787/api/games', {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);

            const games = await response.json();
            return games;
        } catch (err) {
            if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                return { error: 'OFFLINE' };
            }
            console.error("Playnite API Connection Failed:", err.message);
            return null;
        }
    }, // <-- Comma separates the functions

    searchGame: async function(query) {
        try {
            // Encode the query so spaces and special characters don't break the URL
            const response = await fetch(`http://localhost:8787/api/search?name=${encodeURIComponent(query)}`, {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);

            const games = await response.json();
            return games; // Returns an array of matched games
        } catch (err) {
            // Detect if the port is completely closed (Playnite is not running)
            if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                return { error: 'OFFLINE' };
            }
            console.error("Playnite Search API Connection Failed:", err.message);
            return null;
        }
    }, // <-- Comma separates the functions

    launchGame: async function(id) {
        try {
            const response = await fetch(`http://localhost:8787/api/launch?id=${id}`, {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);

            return await response.json();
        } catch (err) {
            if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                return { error: 'OFFLINE' };
            }
            console.error("Playnite Launch API Failed:", err.message);
            return null;
        }
    },
    getStats: async function() {
            try {
                const response = await fetch('http://localhost:8787/api/stats', {
                    signal: AbortSignal.timeout(5000)
                });

                if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);

                return await response.json();
            } catch (err) {
                if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                    return { error: 'OFFLINE' };
                }
                console.error("Playnite Stats API Failed:", err.message);
                return null;
            }
        }
};