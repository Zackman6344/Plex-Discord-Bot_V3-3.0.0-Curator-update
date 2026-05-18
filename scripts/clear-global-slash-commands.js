// One-off cleanup. Run with `node scripts/clear-global-slash-commands.js`.
//
// Clears ALL globally-registered slash commands for this bot's application.
// Use this if Discord shows duplicate /<name> entries because a stale global
// registration was left behind when testGuildId got turned on (the bot now
// registers in a guild, but Discord still serves the old global set).

const { Client, GatewayIntentBits } = require('discord.js');
const keys = require('../config/keys.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag} (id=${client.user.id})`);

    try {
        const before = await client.application.commands.fetch();
        console.log(`Global commands before: ${before.size}`);
        await client.application.commands.set([]);
        const after = await client.application.commands.fetch();
        console.log(`Global commands after:  ${after.size}`);
        console.log('Done. Discord can take up to an hour to drop the entries from active clients.');
    } catch (err) {
        console.error('Clear failed:', err.message || err);
        await client.destroy();
        process.exit(1);
    }

    await client.destroy();
    process.exit(0);
});

client.login(keys.botToken).catch((err) => {
    console.error('Login failed:', err.message || err);
    process.exit(1);
});
