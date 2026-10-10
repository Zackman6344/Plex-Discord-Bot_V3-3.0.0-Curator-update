// helpers/bookAudio.js
//
// ffmpeg arguments and environment for audiobook playback. Pure, so the exact command line is
// testable without spawning anything.

const PROXY_VARS = new Set(['http_proxy', 'https_proxy', 'all_proxy']);

/**
 * ffmpeg arguments that read one Plex part over HTTP (through helpers/partProxy.js) and write
 * Ogg/Opus to stdout.
 *
 * `-ss` goes before `-i`: on an HTTP input ffmpeg seeks by Range, exact to the sample on m4b and
 * CBR/VBR mp3, and the offset stays in source time under atempo. (Music's seek puts it after
 * `-i -` because a pipe cannot seek; see helpers/seek.js.) Never `-usetoc` or `-headers`: the
 * token must not reach ffmpeg's command line, and a byte-range estimate lands in the wrong place
 * on VBR files.
 *
 * The reconnect flags let ffmpeg resume a dropped Plex request through Range instead of ending
 * the part early.
 */
function bookArgs({ url, startMs, speed }) {
	return [
		'-nostdin', '-loglevel', '0',
		'-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
		...(startMs > 0 ? ['-ss', (startMs / 1000).toFixed(3)] : []),
		'-i', url,
		'-analyzeduration', '0', '-vn',
		...(speed !== 1 ? ['-af', `atempo=${speed}`] : []),
		'-acodec', 'libopus', '-f', 'opus', '-ar', '48000', '-ac', '2',
		'pipe:1'
	];
}

/**
 * A copy of `env` without the proxy variables.
 *
 * ffmpeg sends even 127.0.0.1 through `http_proxy`, which would carry the part URL (and its path
 * secret) off the machine and break playback. Matched case-insensitively because Windows treats
 * environment names that way and a copied env can hold any spelling.
 */
function ffmpegEnv(env) {
	const out = {};
	for (const [name, value] of Object.entries(env || {})) {
		if (!PROXY_VARS.has(name.toLowerCase())) out[name] = value;
	}
	return out;
}

module.exports = { bookArgs, ffmpegEnv };
