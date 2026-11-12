const packageJson = require('../package.json');
const logger = require('../helpers/logger.js');
const { runHealthCheck, formatHealthCheck } = require('../helpers/healthCheck.js');

// Discord refuses a message over 2,000 characters outright, and the report grows with every slot
// and room that has a problem.
function fit(text, room) {
  if (text.length <= room) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length >= room) break;
    out += ch;
  }
  return `${out}…`;
}

module.exports = {
  name : 'diag',
  aliases : ['plextest'],
  command : {
    usage: '',
    description: 'Full diagnostic — checks Plex, Gemini, Tautulli, and Playnite connectivity.',
    slash: {
      description: 'Full diagnostic — checks Plex, Gemini, Tautulli, and Playnite connectivity'
    },
    process: async function(bot, client, message) {
      const results = await runHealthCheck();
      const formatted = formatHealthCheck(results);
      const header = `Bot v${packageJson.version} — boot diagnostic`;

      if (message) {
        // The Plex Media line can quote a player's slot name or a room's own words, so nothing in
        // the report pings.
        const head = `🩺 **${header}**\n\`\`\`\n`;
        const tail = '\n```';
        const content = `${head}${fit(formatted, 2000 - head.length - tail.length)}${tail}`;
        message.reply({ content, allowedMentions: { parse: [] } });
      } else {
        logger.info(`${header}:\n${formatted}`);
      }
    }
  }
};
