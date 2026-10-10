// commands/voicehealth.js
//
// Reads the opt-in voice-health log (helpers/voiceHealth.js). `mark` is for the moment a listener
// hears a stutter: it stamps the timeline so the minute can be read off against send gaps, CPU
// and reconnects, and replies with the last two minutes.

const voiceHealth = require('../helpers/voiceHealth.js');
const format = require('../helpers/voiceHealthFormat.js');
const config = require('../config/config.js');
const logger = require('../helpers/logger.js');

const DEFAULT_MINUTES = 15;
const MAX_MINUTES = 120;
const MARK_MINUTES = 2;

function parse(query) {
	const words = String(query || '').trim().split(/\s+/).filter(Boolean);
	if (words[0] && words[0].toLowerCase() === 'show') words.shift();
	if (words.length === 0) return { action: 'show', minutes: DEFAULT_MINUTES };
	if (words[0].toLowerCase() === 'mark') return { action: 'mark', note: words.slice(1).join(' ') };
	if (words.length === 1 && /^\d+$/.test(words[0])) {
		const n = parseInt(words[0], 10);
		if (n >= 1 && n <= MAX_MINUTES) return { action: 'show', minutes: n };
	}
	return { action: 'usage' };
}

/**
 * The reply text for a query. Pure apart from the mark it records.
 * @param {string} query
 * @param {{ health?: object, user?: string|null, prefix?: string, timeOf?: Function }} [opts]
 */
function respond(query, { health = voiceHealth, user = null, prefix = config.commandPrefix, timeOf } = {}) {
	if (!health.isEnabled()) {
		return 'Voice health logging is off. The owner can turn it on in `/config` under Voice ' +
			'("Voice health log"); it starts at once, no restart. It then keeps the last 2 hours in ' +
			'memory and writes data/logs/voice-*.jsonl.';
	}
	const req = parse(query);
	if (req.action === 'usage') {
		return `Usage: \`${prefix}voicehealth [minutes 1-${MAX_MINUTES}]\`, or \`${prefix}voicehealth mark <what you heard>\` right after a stutter.`;
	}
	if (req.action === 'mark') {
		// A backtick in the note would close the code block the event list is printed in.
		const note = (req.note || 'stutter').replace(/`/g, "'");
		health.mark(note, user);
		return format.render(health.snapshot(MARK_MINUTES), {
			minutes: MARK_MINUTES,
			title: `**Marked.** The last ${MARK_MINUTES} min (host clock):`,
			timeOf
		});
	}
	return format.render(health.snapshot(req.minutes), { minutes: req.minutes, timeOf });
}

module.exports = {
	name: 'voicehealth',
	command: {
		usage: '!voicehealth [minutes] | !voicehealth mark <note>',
		description: 'Voice stutter diagnostics: send gaps, source underruns, reconnects and CPU per minute. Off until enabled in /config.',
		slash: {
			description: 'Voice stutter diagnostics: send gaps, reconnects and CPU per minute',
			subcommands: [
				{
					name: 'show',
					description: 'Show the recent minutes (default 15)',
					options: [{ name: 'minutes', type: 'INTEGER', description: `Minutes to show, 1-${MAX_MINUTES}`, required: false }]
				},
				{
					name: 'mark',
					description: 'Mark a stutter you just heard, and show the last 2 minutes',
					options: [{ name: 'note', type: 'STRING', description: 'What you heard, e.g. "choppy for 2 s"', required: false }]
				}
			]
		},
		process: async function(bot, client, message, query) {
			if (!message) return;
			const author = message.author || {};
			let content;
			try {
				content = respond(query, { user: author.username || author.id || null });
			} catch (err) {
				logger.error('voicehealth failed:', (err && err.stack) || err);
				content = 'Could not read the voice health log; see the bot log.';
			}
			return message.reply({ content, allowedMentions: { parse: [] } });
		}
	},
	_test: { parse, respond, DEFAULT_MINUTES, MAX_MINUTES, MARK_MINUTES }
};
