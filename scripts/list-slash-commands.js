// One-off diagnostic. Run with `node scripts/list-slash-commands.js`.
//
// Use this when Discord shows duplicate /<name> entries and you need to know
// which scope each one is registered in — global vs. guild. Logs in once,
// fetches both registration sets for the bot's application, then exits.

const { Client, GatewayIntentBits } = require('discord.js');
const keys = require('../config/keys.js');
const config = require('../config/config.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function fmt(cmd) {
    const optCount = Array.isArray(cmd.options) ? cmd.options.length : 0;
    return `  /${cmd.name}  (${optCount} option${optCount === 1 ? '' : 's'})  — ${cmd.description}`;
}

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag} (id=${client.user.id})`);
    console.log(`Application id: ${client.application.id}`);

    try {
        const globals = await client.application.commands.fetch();
        console.log(`\nGlobal commands: ${globals.size}`);
        globals.forEach(c => console.log(fmt(c)));
    } catch (err) {
        console.error('Failed to fetch global commands:', err.message || err);
    }

    if (config.testGuildId) {
        try {
            const guild = await client.guilds.fetch(config.testGuildId);
            const guildCmds = await guild.commands.fetch();
            console.log(`\nGuild "${guild.name}" (${config.testGuildId}) commands: ${guildCmds.size}`);
            guildCmds.forEach(c => console.log(fmt(c)));
        } catch (err) {
            console.error(`Failed to fetch guild commands for ${config.testGuildId}:`, err.message || err);
        }
    } else {
        console.log('\n(config.testGuildId not set — skipping guild fetch)');
    }

    await client.destroy();
    process.exit(0);
});

client.login(keys.botToken).catch((err) => {
    console.error('Login failed:', err.message || err);
    process.exit(1);
});
