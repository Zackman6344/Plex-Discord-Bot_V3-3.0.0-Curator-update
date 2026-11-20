// /apmedia apworld (owner): the Plex Media world as an .apworld file, with how to install it.
//
// The file is built in memory and attached; the bot never writes into the Archipelago install. It
// only reads the installed copy, to say when that copy is another version, holds files that differ
// from this build, or is not a zip at all: AP 0.6.8 fails to start every program on the PC while a
// broken .apworld sits in custom_worlds.

const logger = require('../../helpers/logger.js');
const contracts = require('../../helpers/apMediaContracts.js');
const common = require('./common.js');

const FILE = `${contracts.APWORLD_NAME}.apworld`;

function differsNote(version, differ) {
	const names = differ.map((name) => `\`${String(name).replace(/`/g, "'")}\``);
	const n = names.length;
	if (n === 1) {
		return `\u26A0\uFE0F This PC has world ${version} installed with 1 file that differs from this one (${names[0]}): install this one over it.`;
	}
	const shown = n > 3 ? `${names.slice(0, 3).join(', ')} and ${n - 3} more` : `${names.slice(0, -1).join(', ')} and ${names[n - 1]}`;
	return `\u26A0\uFE0F This PC has world ${version} installed with ${n} files that differ from this one (${shown}): install this one over it.`;
}

/** What the installed copy says about itself next to this build, as a reply line, or null with no install set. */
function installedNote(build, built, file) {
	if (!file) return null;
	const version = built.worldVersion;
	let found;
	try {
		found = build.compareInstalled(file, built);
		if (found.state === 'unreadable' || found.state === 'notzip') {
			logger.warn(`/apmedia apworld: the installed ${FILE} reads as ${found.state}${found.code ? ` (${found.code})` : ''}`);
		}
	} catch (err) {
		logger.warn(`/apmedia apworld: the installed ${FILE} could not be read:`, (err && err.message) || err);
		found = { state: 'notzip' };
	}
	switch (found.state) {
	case 'missing':
		return `This PC has no ${FILE} installed yet (Archipelago's custom_worlds folder).`;
	case 'unreadable':
		return `\u26A0\uFE0F The installed ${FILE} could not be read (${found.code}), so its version is unknown.`;
	case 'notzip':
		return `\u26A0\uFE0F The installed ${FILE} is not a valid zip: while it is there, every Archipelago program on this PC fails to start. Install this one over it.`;
	case 'nomanifest':
		return `\u26A0\uFE0F The installed ${FILE} has no archipelago.json, so Archipelago cannot tell its version: install this one over it.`;
	case 'version':
		return `\u26A0\uFE0F This PC has world ${found.version ? common.esc(found.version) : 'with no version'} installed, and this file is ${version}: install it to bring the PC up to date.`;
	case 'differs':
		return differsNote(version, found.differ);
	default:
		return `This PC already has world ${version} installed.`;
	}
}

async function run(ctx) {
	const gate = common.ownerOnly(ctx, 'hand out the apworld');
	if (gate) return ctx.say(gate);
	const build = ctx.apworld();
	let built;
	try {
		built = build.buildApworld();
	} catch (err) {
		// The reason names the bot's own folders, and this reply is public.
		logger.warn('/apmedia apworld: the world could not be packed:', (err && err.message) || err);
		return ctx.say('\u274C The apworld could not be built; the bot log has the reason.');
	}
	const kb = Math.max(1, Math.round(built.bytes / 1024));
	const lines = [
		`\u{1F4E6} \`${FILE}\`: the ${contracts.GAME} world ${built.worldVersion} (${kb} KB), for Archipelago ${contracts.MIN_AP_VERSION} or later.`,
		'Install it on the PC that generates the seed: in the Archipelago Launcher choose **Install APWorld**, pick this file, then restart the Launcher.',
		`Keep it installed for as long as the seed's room lives: \`${ctx.p}ap next\` rebuilds the seed from it, and without it every slot gets sphere 1 only.`,
	];
	const note = installedNote(build, built, ctx.installedApworld());
	if (note) lines.push(note);
	return ctx.say({ content: lines.join('\n'), files: [{ attachment: built.buffer, name: FILE }] });
}

module.exports = { names: ['apworld'], run, installedNote, FILE };
