// helpers/selection.js
//
// The two bits of arithmetic behind how a curated queue is assembled. Pure functions with an
// injectable RNG, because both are probabilistic and the behaviour that matters is the
// distribution over many runs, not any single result.

/**
 * How many slots of a queue to hand to wildcard picks.
 *
 * Rounding here is *stochastic*, not floor or nearest. A queue is usually small — the default
 * /vibe asks for 3-6 tracks — and flooring means the setting silently does nothing at those
 * sizes: 25% of 3 is 0.75, floored to zero. Nearest-rounding fixes that but then permanently
 * overshoots or undershoots any size that doesn't divide evenly.
 *
 * Rounding the fraction probabilistically instead means 25% of 3 gives one wildcard 75% of the
 * time and none otherwise, so the *average* over runs is exactly the percentage asked for, at
 * every queue size. The setting always does something, and never more than it promised.
 *
 * @param {number} target   - how many tracks the queue will hold
 * @param {number} percent  - 0-100
 * @param {function} rng    - injectable for tests
 * @returns {number} slots to give to wildcards, never the whole queue
 */
function discoveryQuota(target, percent, rng = Math.random) {
    if (!Number.isFinite(target) || target < 2) return 0;
    if (!Number.isFinite(percent) || percent <= 0) return 0;

    const exact = (target * percent) / 100;
    let quota = Math.floor(exact);
    if (rng() < exact - quota) quota += 1;

    // Never hand over the entire queue: a vibe request should always keep some curated picks.
    return Math.max(0, Math.min(quota, target - 1));
}

/**
 * Shuffle weighted by relevance (Efraimidis-Spirakis): each item draws a key of
 * `random ^ (1 / weight)` and the list is sorted by it. A track matching six of the requested
 * moods lands near the front far more often than one matching a single mood — but every track
 * keeps a real chance at every position, so the same request twice doesn't return the same
 * ordering, and a strong match is never *guaranteed* a slot.
 *
 * @param {Array} items
 * @param {function} weightOf - item -> positive number; higher means "prefer this"
 * @param {function} rng      - injectable for tests
 */
function weightedShuffle(items, weightOf, rng = Math.random) {
    if (!Array.isArray(items)) return [];
    return items
        .map((item) => {
            const weight = Math.max(0.0001, Number(weightOf(item)) || 0.0001);
            return { item, key: Math.pow(rng(), 1 / weight) };
        })
        .sort((a, b) => b.key - a.key)
        .map((scored) => scored.item);
}

module.exports = { discoveryQuota, weightedShuffle };
