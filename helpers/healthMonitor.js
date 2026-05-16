// helpers/healthMonitor.js
// Wraps the one-shot health check in a scheduled monitor. Runs an initial check
// at boot, then re-checks every INTERVAL_MS. On any status transition (ok ↔ error,
// disabled → ok, etc.) it logs a warning and DMs the bot owner if `config.ownerId` is set.
//
// Status transition examples:
//   ok       → error      = something broke
//   error    → ok         = something recovered
//   disabled → anything   = a feature got turned on without restart (rare)
const config = require('../config/config.js');
const logger = require('./logger.js');
const { runHealthCheck, formatHealthCheck } = require('./healthCheck.js');

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let previousStatuses = null;

function statusMap(results) {
    const out = {};
    for (const [k, v] of Object.entries(results)) out[k] = v.status;
    return out;
}

function diffStatuses(prev, curr) {
    const changes = [];
    for (const key of Object.keys(curr)) {
        if (prev[key] !== curr[key]) {
            changes.push({ key, from: prev[key], to: curr[key] });
        }
    }
    return changes;
}

async function dmOwner(client, message) {
    if (!config.ownerId) return;
    try {
        const user = await client.users.fetch(config.ownerId);
        await user.send(message);
    } catch (err) {
        logger.error('Could not DM owner about health change:', err.message || err);
    }
}

async function tick(client) {
    let results;
    try {
        results = await runHealthCheck();
    } catch (err) {
        logger.error('Health check tick threw:', err);
        return;
    }

    const formatted = formatHealthCheck(results);

    if (!previousStatuses) {
        logger.info('Boot health check:\n' + formatted);
        // Make config errors extra loud — they cause silent "bot up, nothing works" failure
        // modes that are easy to miss in the green-checkmark report above.
        if (results.config && results.config.status === 'error') {
            logger.warn('⚠️  CONFIG ISSUES DETECTED — the bot will likely not function correctly:');
            for (const issue of results.config.detail.split(' | ')) {
                logger.warn('  • ' + issue);
            }
            logger.warn('Edit config/config.js to fix, then restart.');
        }
    } else {
        const changes = diffStatuses(previousStatuses, statusMap(results));
        if (changes.length > 0) {
            const summary = changes.map(c => `${c.key}: ${c.from} → ${c.to}`).join(', ');
            logger.warn('Health check status changed: ' + summary);
            const dmBody =
                `🩺 **Health change detected**\n` +
                changes.map(c => `• **${c.key}**: \`${c.from}\` → \`${c.to}\``).join('\n') +
                `\n\n\`\`\`\n${formatted}\n\`\`\``;
            await dmOwner(client, dmBody);
        }
    }

    previousStatuses = statusMap(results);
}

function startHealthMonitor(client) {
    tick(client).then(() => {
        logger.info(`Health monitor scheduled — re-checking every ${INTERVAL_MS / 60000} minutes`);
    });
    return setInterval(() => tick(client), INTERVAL_MS);
}

module.exports = { startHealthMonitor };
