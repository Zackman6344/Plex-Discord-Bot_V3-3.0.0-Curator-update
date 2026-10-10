// helpers/bookResource.js
//
// One audiobook part as an AudioResource: ffmpeg-static reads the part from the loopback proxy
// and writes Ogg/Opus, which voice only demuxes.
//
// ffmpeg is spawned here rather than through prism's FFmpeg because prism spawns with
// `{ windowsHide, shell }` only (prism-media src/core/FFmpeg.js), so it cannot drop the proxy
// variables from ffmpeg's environment.

const { spawn } = require('child_process');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { bookArgs, ffmpegEnv } = require('./bookAudio.js');
const logger = require('./logger.js');
const commandLog = require('./commandLog.js');

function partIdOf(url) {
	const m = /\/library\/parts\/(\d+)\//.exec(url || '');
	return m ? m[1] : '?';
}

/**
 * Start ffmpeg on `url` at `startMs` (source time) and `speed`, and wrap its stdout.
 *
 * Returns `{ resource, kill }`. `kill` is safe to call any number of times. A spawn failure only
 * logs: stdout then ends, the player goes Idle, and the engine's early-end policy decides.
 *
 * `opts.ffmpegPath` and `opts.spawn` exist for tests.
 */
function createBookResource({ url, startMs, speed }, opts = {}) {
	const ffmpegPath = opts.ffmpegPath || require('ffmpeg-static');
	const spawnFn = opts.spawn || spawn;
	const child = spawnFn(ffmpegPath, bookArgs({ url, startMs, speed }), {
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'ignore'],
		env: ffmpegEnv(process.env)
	});

	child.on('error', (err) => {
		const partId = partIdOf(url);
		logger.error(`Audiobook ffmpeg failed for part ${partId}: ${err.message}`);
		commandLog.recordEvent('book-stream-error', { partId, error: err.code || err.message });
	});

	// A process that has exited, or was killed (exitCode stays null after a signal), may have its
	// pid reused by the OS, so a later kill must not reach it.
	const kill = () => {
		if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL');
	};

	const resource = createAudioResource(child.stdout, { inputType: StreamType.OggOpus });
	// Voice destroys playStream on every stop and swap but never touches the process behind it,
	// and ffmpeg blocked writing to a stdout nobody reads would otherwise stay alive.
	resource.playStream.once('close', kill);
	return { resource, kill };
}

module.exports = { createBookResource };
