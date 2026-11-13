// apworld/tests/fill_creator.js
// Fills in a YAML from the Archipelago Options Creator the way /apmedia yaml does once Plex has
// answered, for scenario H (apworld/tests/test_creator.py) and test/apMediaCreatorFile.test.js.
//
//   node apworld/tests/fill_creator.js <creator.yaml> <filled.yaml>
//
// The file is decoded the way the command decodes an attachment (UTF-8, a byte order mark dropped)
// and read by the real readPlayerYaml. Its params get an account and a Discord id where the command
// fills in the linked ones, and go through the real validateParams, the first step of build(). Where
// build() then picks titles from Plex, this takes the 10 entries of fixtures/builder1_mixed.yaml, and
// the real renderYaml writes the file from the same fields build() hands it, at a fixed creation
// time so the same input always gives the same bytes. stdout gets a JSON summary of what
// readPlayerYaml found; a refusal goes to stderr with exit status 1.
//
// Of the bot, only helpers/apMediaYaml.js and what it loads (the contracts, the planner and the yaml
// package) run here: the command module loads the logger, which writes into the checkout's data/logs
// when no test runner is around.

const fs = require('node:fs');
const path = require('node:path');

const { readPlayerYaml, renderYaml, validateParams, listDoc, _internal } = require('../../helpers/apMediaYaml.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'builder1_mixed.yaml');
// builder1_mixed.yaml's own list_info values, so a filled list reads like that fixture.
const ACCOUNT = 1;
const DISCORD = '1234';
const CREATED_AT = 1731200000;

/** The entries of fixtures/builder1_mixed.yaml: one JSON object per "    - " line, the bot's layout. */
function fixtureEntries() {
	return fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/)
		.filter((line) => line.startsWith('    - '))
		.map((line) => JSON.parse(line.slice('    - '.length)));
}

/**
 * @param {Buffer|string} file the YAML as the Creator saved it
 * @returns {{yaml: string, read: object, entries: object[], fileName: string}} the filled file, what
 *   readPlayerYaml returned, the entries written and the file name the command would attach it as
 */
function fill(file) {
	const text = typeof file === 'string' ? file : new TextDecoder('utf-8', { fatal: true }).decode(file);
	const read = readPlayerYaml(text);
	const p = validateParams({ ...read.params, accountId: ACCOUNT, discordUserId: DISCORD });
	const entries = fixtureEntries();
	const yaml = renderYaml(listDoc(p, { createdAt: CREATED_AT, entries }));
	return { yaml, read, entries, fileName: _internal.safeFileName(p.name) };
}

function main([input, output]) {
	if (!input || !output) {
		process.stderr.write('usage: node apworld/tests/fill_creator.js <creator.yaml> <filled.yaml>\n');
		return 2;
	}
	let filled;
	try {
		filled = fill(fs.readFileSync(input));
	} catch (err) {
		process.stderr.write(`${err.message}\n`);
		return 1;
	}
	fs.writeFileSync(output, filled.yaml, 'utf8');
	const { read } = filled;
	process.stdout.write(`${JSON.stringify({
		name: read.name,
		label: read.label === undefined ? null : read.label,
		random: read.random,
		passthrough: read.passthrough.map(([key]) => key),
		entriesCount: read.entriesCount,
		entries: filled.entries.length,
		fileName: filled.fileName,
	})}\n`);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { fill, fixtureEntries, ACCOUNT, DISCORD, CREATED_AT };
