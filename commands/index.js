// Auto-load every command file in this directory. Logs a summary line at boot so a fresh
// user immediately sees how many commands loaded and which (if any) failed — instead of
// the previous silent try/catch where a broken command would just disappear with no signal.
const logger = require('../helpers/logger.js');

const loaded = [];
const failed = [];
let aliasCount = 0;

require('fs').readdirSync(__dirname + '/').forEach(function(file) {
  if (file.match(/\.js$/) && file !== 'index.js') {
    try {
      const command = require(__dirname + '/' + file);
      module.exports[command.name] = command.command;
      loaded.push(command.name);
      // A command may declare `aliases: ['oldname', ...]` for additional invocation names
      // (e.g. !plextest → !diag backward-compat).
      if (Array.isArray(command.aliases)) {
        for (const alias of command.aliases) {
          module.exports[alias] = command.command;
          aliasCount++;
        }
      }
    } catch (err) {
      failed.push({ file, error: err && err.message ? err.message : String(err) });
    }
  }
});

const aliasNote = aliasCount ? ` (${aliasCount} alias${aliasCount === 1 ? '' : 'es'})` : '';
logger.info(`Loaded ${loaded.length} commands${aliasNote}`);
if (failed.length > 0) {
  logger.error(`Failed to load ${failed.length} command file(s):`);
  for (const f of failed) {
    logger.error(`  • ${f.file}: ${f.error}`);
  }
}
