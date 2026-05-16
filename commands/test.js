const packageJson = require('../package.json');
const logger = require('../helpers/logger.js');
const { runHealthCheck, formatHealthCheck } = require('../helpers/healthCheck.js');

module.exports = {
  name : 'diag',
  aliases : ['plextest'],
  command : {
    usage: '',
    description: 'Full diagnostic — checks Plex, Gemini, Tautulli, and Playnite connectivity.',
    process: async function(bot, client, message) {
      const results = await runHealthCheck();
      const formatted = formatHealthCheck(results);
      const header = `Bot v${packageJson.version} — boot diagnostic`;

      if (message) {
        message.reply(`🩺 **${header}**\n\`\`\`\n${formatted}\n\`\`\``);
      } else {
        logger.info(`${header}:\n${formatted}`);
      }
    }
  }
};
