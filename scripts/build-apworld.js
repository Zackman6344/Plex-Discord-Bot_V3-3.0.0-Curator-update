// scripts/build-apworld.js
// Builds dist/plex_media.apworld from apworld/plex_media (npm run build:apworld).
//
// The owner installs the result with the Archipelago Launcher's "Install APWorld". Nothing here
// touches the Archipelago install itself.

const path = require('node:path');

const { writeApworld } = require('../helpers/apworldBuild.js');

const OUT = path.join(__dirname, '..', 'dist', 'plex_media.apworld');

try {
	const built = writeApworld(OUT);
	console.log(`Wrote ${built.file}: world_version ${built.worldVersion}, ${built.files.length} files, ${built.bytes} bytes.`);
} catch (err) {
	console.error(`Could not build the apworld: ${err.message}`);
	process.exitCode = 1;
}
