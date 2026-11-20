// helpers/healthMonitor.js
// Wraps the one-shot health check in a scheduled monitor. Runs an initial check
// at boot, then re-checks every INTERVAL_MS. On any status transition (ok ↔ error,
// disabled → ok, etc.) it logs a warning and DMs the bot owner if `config.ownerId` is set.
//
// Status transition examples:
//   ok       → error      = something broke
//   error    → ok         = something recovered
//   disabled → anything   = a feature got turned on without restart (rare)
//
// A check may also return `problems: [{key, text}]`. A key the last check did not have is logged
// and DMed even while the status stays the same; a key that went away is only logged.
const config = require('../config/config.js');
const logger = require('./logger.js');
const { runHealthCheck, formatHealthCheck } = require('./healthCheck.js');

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let previousStatuses = null;
let previousProblems = null;
let monitorTimer = null;
// Bumped on every start and stop. A check that was still waiting on its results when the monitor
// it belongs to stopped must not report: its client is the one !restart destroyed.
let generation = 0;

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

function problemMap(results) {
    const out = {};
    for (const [check, result] of Object.entries(results)) {
        if (!result || !Array.isArray(result.problems)) continue;
        out[check] = new Map(result.problems.map(p => [p.key, p.text]));
    }
    return out;
}

function newProblems(prev, curr) {
    const fresh = [];
    for (const [check, problems] of Object.entries(curr)) {
        for (const [key, text] of problems) {
            if (!(prev[check] && prev[check].has(key))) fresh.push({ check, text });
        }
    }
    return fresh;
}

function cleared(prev, curr) {
    return newProblems(curr, prev);
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

async function tick(client, gen) {
    let results;
    try {
        results = await runHealthCheck();
    } catch (err) {
        logger.error('Health check tick threw:', err);
        return;
    }
    if (gen !== generation) return;

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
        // One compact line per check, even when nothing changed. Without it a healthy bot writes
        // nothing for hours, so a log whose last line is two hours old says nothing about whether
        // the bot died then or is still running — which is exactly the position a silent death
        // left us in. This bounds it to the check interval.
        const counts = Object.values(statusMap(results)).reduce((acc, status) => {
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});
        logger.info('Health check: ' + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));

        const changes = diffStatuses(previousStatuses, statusMap(results));
        const problems = problemMap(results);
        const fresh = newProblems(previousProblems || {}, problems);
        for (const p of fresh) logger.warn(`Health check: new problem: ${p.check}: ${p.text}`);
        for (const p of cleared(previousProblems || {}, problems)) logger.info(`Health check: cleared: ${p.check}: ${p.text}`);
        if (changes.length > 0) {
            const summary = changes.map(c => `${c.key}: ${c.from} → ${c.to}`).join(', ');
            logger.warn('Health check status changed: ' + summary);
        }
        if (changes.length || fresh.length) {
            const title = changes.length ? 'Health change detected'
                : fresh.length === 1 ? 'New health problem' : 'New health problems';
            const lines = changes.map(c => `• **${c.key}**: \`${c.from}\` → \`${c.to}\``)
                .concat(fresh.map(p => `\u2022 **${p.check}**${changes.length ? ', new' : ''}: ${p.text}`));
            const dmBody =
                `\u{1FA7A} **${title}**\n` +
                lines.join('\n') +
                `\n\n\`\`\`\n${formatted}\n\`\`\``;
            await dmOwner(client, dmBody);
        }
    }

    // Again after the DM: a stop that lands while it is being sent (through the client being
    // destroyed, so it may not arrive) leaves the baseline alone, and the new monitor reports the
    // change itself. A notice sent twice beats one never sent.
    if (gen !== generation) return;
    previousStatuses = statusMap(results);
    previousProblems = problemMap(results);
}

// Replaces any monitor already running. !restart starts a new one for the new client, and the old
// one's interval used to keep running beside it, so every check ran and logged twice.
function startHealthMonitor(client) {
    stopHealthMonitor();
    const gen = generation;
    tick(client, gen).then(() => {
        if (gen === generation) logger.info(`Health monitor scheduled — re-checking every ${INTERVAL_MS / 60000} minutes`);
    });
    monitorTimer = setInterval(() => tick(client, gen), INTERVAL_MS);
    return monitorTimer;
}

function stopHealthMonitor() {
    generation++;
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
}

module.exports = { startHealthMonitor, stopHealthMonitor };
