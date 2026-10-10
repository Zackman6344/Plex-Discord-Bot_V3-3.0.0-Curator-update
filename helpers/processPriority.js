// helpers/processPriority.js
//
// Runs the bot above Normal priority so a game, VR stream or Plex transcode on the same PC cannot
// starve the 20 ms voice send timer. Measured on the host under CPU load: the worst send gap was
// 359 ms at Normal and 34 ms at ABOVE_NORMAL.
//
// Only this process is raised. Windows starts a child of an ABOVE_NORMAL parent at Normal (only
// Idle and Below Normal are inherited), so ffmpeg transcodes keep competing on equal terms with
// everything else instead of with the voice timer.

const SETTINGS = {
	above_normal: 'PRIORITY_ABOVE_NORMAL',
	normal: 'PRIORITY_NORMAL'
};
const DEFAULT_SETTING = 'above_normal';

// Linux and Docker refuse a raise without CAP_SYS_NICE, and that answer will not change while the
// process lives, so one warning is enough even across !restart and live config changes.
let warned = false;

function nameOf(value, constants) {
	for (const [name, v] of Object.entries(constants)) {
		if (v === value) return name.replace(/^PRIORITY_/, '').toLowerCase();
	}
	return String(value);
}

/**
 * Apply a priority setting to the current process. Never throws.
 * @param {string} setting 'above_normal' | 'normal'; anything else means the default
 * @param {{ os?: object, logger?: object }} [deps]
 * @returns {{ setting: string, ok: boolean, effective: string, error: string|null }}
 */
function apply(setting, { os = require('os'), logger = require('./logger.js') } = {}) {
	const chosen = Object.prototype.hasOwnProperty.call(SETTINGS, setting) ? setting : DEFAULT_SETTING;
	const constants = os.constants.priority;
	let ok = true;
	let error = null;
	try {
		os.setPriority(0, constants[SETTINGS[chosen]]);
	} catch (err) {
		ok = false;
		error = (err && err.code) || (err && err.message) || String(err);
		if (!warned) {
			warned = true;
			logger.warn(`Could not set process priority to ${chosen} (${error}); the bot runs at the priority it was started with.`);
		}
	}
	let effective = 'unknown';
	try {
		effective = nameOf(os.getPriority(0), constants);
	} catch (_) {}
	logger.info(`Process priority: ${effective}`);
	return { setting: chosen, ok, effective, error };
}

let bound = false;

/** Apply the configured priority now, and again whenever /config changes it. */
function bindToConfig(config, { store = require('./configStore.js'), os, logger } = {}) {
	const deps = {};
	if (os) deps.os = os;
	if (logger) deps.logger = logger;
	const result = apply(config.processPriority, deps);
	if (!bound) {
		bound = true;
		store.onChange((key, value) => {
			if (key === 'processPriority') apply(value, deps);
		});
	}
	return result;
}

/** Test seam: forget the one-time warning and the config subscription. */
function _reset() {
	warned = false;
	bound = false;
}

module.exports = { apply, bindToConfig, SETTINGS, DEFAULT_SETTING, _reset };
