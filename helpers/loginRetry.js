// helpers/loginRetry.js
// Which Discord login failures are worth another try, and how long to wait before it.
//
// A login that cannot reach discord.com rejects with a network error, and before the gateway is
// up nothing else holds the process open, so the bot used to exit with code 0 and stay down until
// someone noticed. Those are retried for as long as it takes. A rejected token or intent fails the
// same way every time, so retrying it would only hide the problem.

const FATAL_CODES = new Set(['TokenInvalid', 'DisallowedIntents']);
const DELAYS_MS = [5000, 15000, 30000, 60000, 120000, 300000];

function isRetryable(err) {
	if (!err) return true;
	if (FATAL_CODES.has(err.code)) return false;
	return err.status !== 401 && err.status !== 403;
}

function retryDelayMs(attempt) {
	return DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
}

module.exports = { isRetryable, retryDelayMs, DELAYS_MS };
