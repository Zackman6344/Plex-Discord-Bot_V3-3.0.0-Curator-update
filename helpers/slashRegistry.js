// helpers/slashRegistry.js
//
// Collects slash command specs from loaded commands and registers them with Discord.
// A command opts in by declaring a `slash` field inside its `command` block:
//
//   module.exports = {
//     name: 'play',
//     command: {
//       slash: {
//         description: 'Add a song to the queue',
//         options: [
//           { name: 'song', type: 'STRING', description: 'Song / URL', required: true }
//         ]
//       },
//       process: async function(bot, client, message, query) { ... }
//     }
//   };
//
// For subcommand patterns (e.g. /playlist create / play / list), use `subcommands`:
//
//   slash: {
//     description: 'Manage custom playlists',
//     subcommands: [
//       { name: 'create', description: '...', options: [{ name: 'name', type: 'STRING', required: true, description: '...' }] },
//       ...
//     ]
//   }
//
// Registration happens on `clientReady`. If `config.testGuildId` is set, commands
// register in that guild instantly. Otherwise they register globally (~1hr propagation).

const { ApplicationCommandOptionType } = require('discord.js');
const config = require('../config/config.js');
const logger = require('./logger.js');

// String-name → numeric Discord enum. Commands declare types as strings for readability.
const TYPE_MAP = {
    STRING: ApplicationCommandOptionType.String,
    INTEGER: ApplicationCommandOptionType.Integer,
    BOOLEAN: ApplicationCommandOptionType.Boolean,
    USER: ApplicationCommandOptionType.User,
    CHANNEL: ApplicationCommandOptionType.Channel,
    ROLE: ApplicationCommandOptionType.Role,
    MENTIONABLE: ApplicationCommandOptionType.Mentionable,
    NUMBER: ApplicationCommandOptionType.Number,
    ATTACHMENT: ApplicationCommandOptionType.Attachment
};

function mapOption(opt) {
    return {
        name: opt.name,
        description: opt.description || 'No description provided',
        type: typeof opt.type === 'string' ? (TYPE_MAP[opt.type] || ApplicationCommandOptionType.String) : opt.type,
        required: !!opt.required,
        ...(opt.choices ? { choices: opt.choices } : {}),
        ...(opt.autocomplete ? { autocomplete: true } : {})
    };
}

function buildSpec(name, slash) {
    const spec = {
        name,
        description: (slash.description || 'No description provided').substring(0, 100)
    };

    if (Array.isArray(slash.subcommands) && slash.subcommands.length > 0) {
        spec.options = slash.subcommands.map(sc => ({
            name: sc.name,
            description: (sc.description || 'No description provided').substring(0, 100),
            type: ApplicationCommandOptionType.Subcommand,
            options: Array.isArray(sc.options) ? sc.options.map(mapOption) : []
        }));
    } else if (Array.isArray(slash.options) && slash.options.length > 0) {
        spec.options = slash.options.map(mapOption);
    }

    return spec;
}

/**
 * Walks the loaded commands map and registers anything with a `.slash` block.
 * @param {Client} client - the Discord client (must be ready)
 * @param {Object} commands - the plexCommands map produced by commands/index.js
 */
async function registerAll(client, commands) {
    const specs = [];
    // Aliases share the same command object reference in plexCommands
    // (commands['?'] === commands['help']), so dedupe by identity, not name. Also enforce
    // Discord's slash-command name rules ^[\w-]{1,32}$ — aliases like '?' would fail validation.
    const seenObjects = new Set();
    const VALID_NAME = /^[\w-]{1,32}$/;
    for (const [name, cmd] of Object.entries(commands)) {
        if (!cmd || !cmd.slash) continue;
        if (seenObjects.has(cmd)) continue;
        seenObjects.add(cmd);
        if (!VALID_NAME.test(name)) {
            logger.warn(`Skipping slash registration for "${name}" — invalid Discord command name.`);
            continue;
        }
        try {
            specs.push(buildSpec(name, cmd.slash));
        } catch (err) {
            logger.error(`Failed to build slash spec for "${name}":`, err.message || err);
        }
    }

    if (specs.length === 0) {
        logger.info('No slash commands declared — skipping registration.');
        return;
    }

    if (config.testGuildId) {
        // Drop stale global registrations so Discord stops showing them alongside
        // the guild-scoped ones we're about to write. Failure here is non-fatal —
        // the guild registration is what we actually need to succeed.
        try {
            await client.application.commands.set([]);
        } catch (err) {
            logger.warn('Failed to clear stale global slash commands:', err.message || err);
        }
        try {
            const guild = await client.guilds.fetch(config.testGuildId);
            await guild.commands.set(specs);
            logger.info(`Registered ${specs.length} slash commands in guild ${config.testGuildId} (instant).`);
        } catch (err) {
            logger.error(`Failed to register slash commands in guild ${config.testGuildId}:`, err.message || err);
        }
    } else {
        try {
            await client.application.commands.set(specs);
            logger.info(`Registered ${specs.length} slash commands globally (may take up to 1 hour to propagate).`);
        } catch (err) {
            logger.error('Failed to register slash commands globally:', err.message || err);
        }
    }
}

/**
 * Build a query string from an interaction's options, formatted to match the way
 * the !-prefix dispatcher would have produced it. The existing command process
 * functions consume `query` as a space-separated string, so this lets them work
 * unchanged.
 *
 * For subcommands: `<subcommand-name> <option1-value> <option2-value> ...`
 * For flat options: `<option1-value> <option2-value> ...`
 *
 * Only string-valued options contribute; user/channel/role/etc. should be read
 * via `interaction.options.getUser()` etc. inside the command if needed.
 */
function buildQueryString(interaction, slashSpec) {
    const parts = [];

    const collectOptions = (optList) => {
        if (!Array.isArray(optList)) return;
        for (const opt of optList) {
            // Options the command reads straight off the interaction (interaction.options.getX)
            // would otherwise be stringified into the arg text and parsed as part of the query.
            if (opt.omitFromQuery) continue;
            const got = interaction.options.get(opt.name);
            if (got && got.value !== undefined && got.value !== null) {
                // `flag` lets a BOOLEAN option emit a literal token (e.g. '-r') so
                // slash invocations can produce arg strings the !-prefix parser
                // already understands, instead of a stringified "true"/"false".
                if (typeof opt.flag === 'string') {
                    if (got.value) parts.push(opt.flag);
                } else {
                    parts.push(String(got.value));
                }
            }
        }
    };

    if (Array.isArray(slashSpec.subcommands) && slashSpec.subcommands.length > 0) {
        let subName = null;
        try { subName = interaction.options.getSubcommand(false); } catch (_) {}
        if (subName) {
            parts.push(subName);
            const subSpec = slashSpec.subcommands.find(s => s.name === subName);
            if (subSpec) collectOptions(subSpec.options);
        }
    } else {
        collectOptions(slashSpec.options);
    }

    return parts.join(' ');
}

module.exports = { registerAll, buildSpec, buildQueryString };
