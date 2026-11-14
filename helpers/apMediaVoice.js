// helpers/apMediaVoice.js
// Turns music the bot plays in Discord voice into Plex Media credit events.
//
// The bot's own voice playback never reaches Plex history (175 bot track-starts, 0 history rows),
// so app/bot.js reports the end of every track's player itself: 'track-heard', from its Idle.
//
// A track counts when the audio that actually went out (the resource's playbackDuration) is at
// least 85% of its length, Tautulli's own threshold. The position proves nothing: a !seek to just
// before the end ends a track naturally a few seconds later. Only a track nobody knows the length
// of falls back to a natural end after 30 s of audio, and the slot index knows the length of every
// track it holds, so that fallback never decides a list title.
//
// A listen short of that is still a stretch of the track that played, from where the resource
// started (0, or a !seek's offset) for as long as audio went out: its album or mix checkpoints
// count, as they do when the same stretch plays through Plexamp.
//
// Credit goes to the people in the channel both when the track started and when it ended, minus
// the deafened: someone who joins for the last second of a song did not hear it, and someone who
// left before the end did not finish it.
//
// 'track-heard' is emitted inside the AudioPlayer's state setter, where a store write, a Discord
// send or a throw lands in voice's audio cycle, so all of the work waits for setImmediate.

const contracts = require('./apMediaContracts.js');
const bookCatalog = require('./bookCatalog.js');
const defaultLogger = require('./logger.js');

const EVENT = 'track-heard';

/** A positive safe integer id, or null. ratingKey arrives from PMS as a string, partIdOf returns one. */
function idOf(value) {
	if (typeof value !== 'number' && typeof value !== 'string') return null;
	if (value === '') return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function msOf(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Whether `heardMs` of audio is a listen of a track `durationMs` long (0 or less: unknown).
 * @param {number} heardMs @param {number} durationMs @param {boolean} natural the stream ended
 * @returns {boolean}
 */
function isHeard(heardMs, durationMs, natural) {
	const heard = msOf(heardMs);
	const duration = msOf(durationMs);
	if (duration > 0) return heard >= contracts.VOICE.heardFraction * duration;
	return !!natural && heard >= contracts.VOICE.naturalMinMs;
}

/**
 * What a queue entry says about the track, in the order apMediaCredit.hitsFor tries them. Saved
 * playlists, !play and /vibe queue entries without a ratingKey, but their part key still names the
 * file, and a slot's album and mix tracks carry its part id.
 * @param {object} entry a Bot queue entry {artist, title, key, album, ratingKey?, duration?}
 * @returns {{ratingKey: number|null, partId: number|null, artist: string, title: string}}
 */
function identify(entry) {
	const e = entry && typeof entry === 'object' ? entry : {};
	return {
		ratingKey: idOf(e.ratingKey),
		partId: idOf(bookCatalog.partIdOf(e.key)),
		artist: contracts.sanitizeText(e.artist),
		title: contracts.sanitizeText(e.title),
	};
}

/**
 * A resolve() for attach() over the slot indexes in force: the first slot whose index holds the
 * track (by ratingKey, then part id, then "artist|title"), with the length of the track or part
 * it hit.
 * @param {() => Iterable<object>} indexes apMediaCredit.indexSlot() results of the active bindings
 * @returns {(entry: object, ident?: object) => ({durationMs: number}|null)}
 */
function createResolver(indexes) {
	if (typeof indexes !== 'function') throw new TypeError('createResolver needs indexes().');
	const credit = require('./apMediaCredit.js');
	return (entry, ident = identify(entry)) => {
		for (const index of indexes() || []) {
			const hits = credit.hitsFor(index, {
				ratingKey: ident.ratingKey,
				partId: ident.partId,
				artist: ident.artist,
				title: ident.title,
			});
			if (hits.length) return { durationMs: Math.max(0, msOf(hits[0].endMs) - msOf(hits[0].startMs)) };
		}
		return null;
	};
}

/**
 * Listen for the Bot's 'track-heard' and hand each listen of a list track to onEvent.
 * @param {object} opts
 * @param {import('events').EventEmitter} opts.bot app/bot.js's Bot: 'track-heard', voiceListeners(),
 *   client.guilds.cache
 * @param {(entry: object, ident: object) => ({durationMs?: number}|null)} opts.resolve null when no
 *   active slot holds the track (a song on no list): nothing is credited then. A queue entry marked
 *   secret (a Hitster clip) is never looked up.
 * @param {(event: object) => (void|Promise)} opts.onEvent receives a CreditEvent (apMediaContracts)
 * @param {() => object} [opts.getConfig] read on every listen; apMediaVoiceCredit false turns it off
 * @param {() => number} [opts.now] @param {(fn: Function) => void} [opts.defer] @param {object} [opts.logger]
 * @returns {() => void} detach; a listen still waiting for its turn is dropped
 */
function attach({ bot, resolve, onEvent, getConfig, now = Date.now, defer = setImmediate, logger = defaultLogger } = {}) {
	if (!bot || typeof bot.on !== 'function') throw new TypeError('apMediaVoice.attach needs the Bot.');
	if (typeof onEvent !== 'function') throw new TypeError('apMediaVoice.attach needs onEvent().');
	const lookup = typeof resolve === 'function' ? resolve : () => null;
	let attached = true;

	function settings() {
		let c = getConfig;
		if (typeof c === 'function') c = c();
		if (!c) c = require('../config/config.js');
		return c || {};
	}

	function listenersAtEnd(guildId, channelId) {
		const cache = bot.client && bot.client.guilds && bot.client.guilds.cache;
		const guild = guildId && cache && typeof cache.get === 'function' ? cache.get(String(guildId)) : null;
		if (!guild || typeof bot.voiceListeners !== 'function') return new Set();
		return new Set(bot.voiceListeners(guild, channelId).map(String));
	}

	function deliver(event) {
		const failed = (err) => logger.warn(`Plex Media: voice credit for "${event.title}" failed:`, (err && err.message) || err);
		let result;
		try {
			result = onEvent(event);
		} catch (err) {
			failed(err);
			return;
		}
		if (result && typeof result.then === 'function') result.then(null, failed);
	}

	function handle(heard, at) {
		if (settings().apMediaVoiceCredit === false) return;
		const entry = heard.entry;
		if (!entry || typeof entry !== 'object') return;
		// A Hitster clip: its credit line or the relay's send line would give its album away before
		// anyone has guessed.
		if (entry.secret) return;
		const ident = identify(entry);
		const found = lookup(entry, ident);
		if (!found) return;
		const durationMs = msOf(entry.duration) || msOf(found.durationMs);
		const heardMs = msOf(heard.heardMs);
		const whole = isHeard(heardMs, durationMs, heard.natural);
		if (!whole && heardMs <= 0) return;
		const atEnd = listenersAtEnd(heard.guildId, heard.channelId);
		const atStart = Array.isArray(heard.startListeners) ? heard.startListeners.map(String) : [];
		const userIds = [...new Set(atStart)].filter((id) => atEnd.has(id));
		if (!userIds.length) return;
		// A whole track is a 'complete', which earns every checkpoint inside it; a short listen is a span.
		// The stretch that went out rides along either way: under timesanity_strict only it counts.
		const fromMs = msOf(heard.startMs);
		const event = {
			type: whole ? 'complete' : 'span',
			source: 'voice',
			userIds,
			ratingKey: ident.ratingKey,
			partId: ident.partId,
			artist: ident.artist,
			title: ident.title,
			fromMs,
			toMs: fromMs + heardMs,
			at,
		};
		deliver(event);
	}

	const listener = (heard) => {
		if (!attached || !heard) return;
		const at = now();
		defer(() => {
			if (!attached) return;
			try {
				handle(heard, at);
			} catch (err) {
				logger.warn('Plex Media: a track heard in voice could not be credited:', (err && err.message) || err);
			}
		});
	};
	bot.on(EVENT, listener);

	return function detach() {
		if (!attached) return;
		attached = false;
		bot.removeListener(EVENT, listener);
	};
}

module.exports = { attach, createResolver, identify, isHeard, EVENT };
