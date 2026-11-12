// /apmedia apworld (owner): the Plex Media world as an .apworld file, with how to install it.
//
// The file is built in memory and attached; the bot never writes into the Archipelago install. It
// only reads the installed copy's manifest, to say when that copy is another version, or is not a
// zip at all: AP 0.6.8 fails to start every program on the PC while a broken .apworld sits in
// custom_worlds.

const logger = require('../../helpers/logger.js');
const contracts = require('../../helpers/apMediaContracts.js');
const common = require('./common.js');

const FILE = `${contracts.APWORLD_NAME}.apworld`;

/** What the installed copy says about itself, as a reply line, or null with no install set. */
function installedNote(build, version, file) {
	if (!file) return null;
	let manifest;
	try {
		manifest = build.readApworldManifest(file);
	} catch (err) {
		if (err && err.code === 'ENOENT') return `This PC has no ${FILE} installed yet (Archipelago's custom_worlds folder).`;
		logger.warn(`/apmedia apworld: the installed ${FILE} could not be read:`, (err && err.message) || err);
		if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY')) {
			return `\u26A0\uFE0F The installed ${FILE} could not be read (${err.code}), so its version is unknown.`;
		}
		return `\u26A0\uFE0F The installed ${FILE} is not a valid zip: while it is there, every Archipelago program on this PC fails to start. Install this one over it.`;
	}
	if (!manifest || typeof manifest !== 'object') {
		return `\u26A0\uFE0F The installed ${FILE} has no archipelago.json, so Archipelago cannot tell its version: install this one over it.`;
	}
	const have = typeof manifest.world_version === 'string' ? manifest.world_version : null;
	if (have !== version) {
		return `\u26A0\uFE0F This PC has world ${have ? common.esc(have) : 'with no version'} installed, and this file is ${version}: install it to bring the PC up to date.`;
	}
	return `This PC already has world ${version} installed.`;
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
	const note = installedNote(build, built.worldVersion, ctx.installedApworld());
	if (note) lines.push(note);
	return ctx.say({ content: lines.join('\n'), files: [{ attachment: built.buffer, name: FILE }] });
}

module.exports = { names: ['apworld'], run, installedNote, FILE };
