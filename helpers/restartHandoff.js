// helpers/restartHandoff.js
// What a game in progress needs from !restart. Its collector and timers belong to the client the
// restart destroys: no guess reaches it again, and its clues and reveal fail with "Expected token
// to be set". Each game tracks itself here while it runs, and utils.stop() ends them all. What a
// game has to say about ending is queued, and the new client posts it once it is ready. A send
// through the client being destroyed may or may not go out.
const logger = require('./logger.js');

// The reason a game's collector is stopped with, so its 'end' handler can tell a restart apart.
const REASON = 'restart';
const live = new Set();
const notices = [];
// Clients a restart has stopped. A round whose setup was still waiting on Plex or Gemini when
// endAll ran registers afterwards, on the old client; it is ended at once rather than left there.
const retired = new WeakSet();
// The client deliver() last posted through. Notices after that go straight out through it.
let ready = null;

// `end` stops the game for a restart. The returned function forgets it, for the game's own end.
function track(end, client) {
	if (client && retired.has(client)) {
		// A microtask, so the caller has attached its own 'end' handling first, as it does right
		// after tracking.
		queueMicrotask(() => runEnd(end));
		return () => {};
	}
	live.add(end);
	return () => live.delete(end);
}

function trackCollector(collector) {
	const forget = track(() => collector.stop(REASON), collector.client);
	collector.once('end', forget);
}

// How a game's 'end' handler posts: to the channel, or after a restart through the new client.
function poster(channel, reason) {
	if (reason === REASON) return (payload) => notice(channel.id, payload);
	return (payload) => channel.send(payload);
}

function isRetired(client) {
	return !!client && retired.has(client);
}

function endAll(client) {
	if (client) retired.add(client);
	ready = null;
	for (const end of [...live]) {
		live.delete(end);
		runEnd(end);
	}
}

function runEnd(end) {
	try {
		end();
	} catch (err) {
		logger.error('Ending a game for the restart failed:', (err && err.message) || err);
	}
}

function notice(channelId, payload) {
	if (ready) {
		post(ready, channelId, payload);
		return;
	}
	notices.push({ channelId, payload });
}

async function deliver(client) {
	ready = client;
	for (const { channelId, payload } of notices.splice(0)) await post(client, channelId, payload);
}

async function post(client, channelId, payload) {
	try {
		const channel = await client.channels.fetch(channelId);
		await channel.send(payload);
	} catch (err) {
		logger.warn(`Restart notice for channel ${channelId} could not be posted:`, (err && err.message) || err);
	}
}

module.exports = { REASON, track, trackCollector, poster, isRetired, endAll, notice, deliver };
