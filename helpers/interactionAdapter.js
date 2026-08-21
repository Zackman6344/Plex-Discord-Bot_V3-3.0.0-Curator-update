// helpers/interactionAdapter.js
//
// Wraps a Discord ChatInputCommandInteraction in a Message-shaped facade so existing
// command process functions — which were written for `messageCreate` events — work
// against slash commands unchanged.
//
// Contract:
// - The interaction MUST already be deferred (with interaction.deferReply()) before
//   this adapter is constructed. The dispatcher in app/music.js handles that.
// - The FIRST call to `adapter.reply(...)` or `adapter.channel.send(...)` routes
//   through `interaction.editReply(...)` so it lands as the interaction's primary
//   response (instead of producing a stray "Bot is thinking..." message).
// - Subsequent calls go through `interaction.channel.send(...)` as normal messages.
//   That preserves the "post a status message, then post more updates" pattern most
//   of the long-running commands already use.
// - `content` is rebuilt in prefix form (`!name args`) rather than set to the bare arg
//   string. Several commands parse their arguments as `content.split(' ').slice(1)`,
//   which assumes the command token is still the first word; handing them a bare arg
//   string makes slice(1) swallow the real argument.
// - An optional `onInteractionResponse` observer is told about anything sent through the
//   interaction itself. That path is `editReply`, which Discord delivers as a message *edit*, so
//   a messageCreate listener never sees it — without this hook the primary reply to every slash
//   command is invisible to the command log.

const config = require('../config/config.js');

function makeChannelProxy(interaction, state) {
    return {
        // Identity / pass-through properties commands read directly
        get id() { return interaction.channel && interaction.channel.id; },
        get name() { return interaction.channel && interaction.channel.name; },
        get type() { return interaction.channel && interaction.channel.type; },
        get guild() { return interaction.channel && interaction.channel.guild; },

        async send(payload) {
            if (!state.firstResponseSent) {
                state.firstResponseSent = true;
                const opts = typeof payload === 'string' ? { content: payload } : payload;
                state.report(opts);
                // editReply returns the resulting Message in v14 — same shape commands
                // expect from channel.send (so .edit() / .delete() chain naturally).
                return interaction.editReply(opts);
            }
            // A real channel message from here on, which a messageCreate listener can see, so
            // reporting it here as well would double-count it.
            return interaction.channel.send(payload);
        },

        createMessageCollector(options) {
            return interaction.channel.createMessageCollector(options);
        },

        awaitMessages(options) {
            return interaction.channel.awaitMessages(options);
        },

        async sendTyping() {
            if (interaction.channel && interaction.channel.sendTyping) {
                return interaction.channel.sendTyping();
            }
        }
    };
}

function makeMentionsProxy(interaction) {
    // Slash commands don't pre-populate "mentions" the way prefix messages do. Commands
    // that care about a USER option should declare it in their slash spec and read it
    // with interaction.options.getUser(name). We provide a fallback shape so legacy
    // code paths that grep for `message.mentions.users.first()` don't crash.
    let cachedFirstUser = null;
    return {
        users: {
            first() {
                if (cachedFirstUser !== null) return cachedFirstUser || undefined;
                // Look for any USER-typed option and return the first.
                if (!interaction.options) { cachedFirstUser = null; return undefined; }
                for (const opt of interaction.options.data || []) {
                    if (opt.user) { cachedFirstUser = opt.user; return opt.user; }
                }
                cachedFirstUser = null;
                return undefined;
            }
        }
    };
}

/**
 * Build a Message-shaped wrapper around the given (already-deferred) interaction.
 *
 * @param {ChatInputCommandInteraction} interaction
 * @param {string} queryString  - space-separated args, as the !-prefix dispatcher would have produced
 * @param {Object} [options]
 * @param {function} [options.onInteractionResponse] - called with anything sent through the
 *   interaction itself (an `editReply`, which Discord delivers as an edit and no messageCreate
 *   listener can see). Purely an observer: it must never affect what the user gets.
 * @returns {Object} a Message-like object suitable for passing as `message` to existing command.process functions
 */
function adaptInteraction(interaction, queryString, { onInteractionResponse = null } = {}) {
    const state = {
        firstResponseSent: false,
        report(payload) {
            if (typeof onInteractionResponse !== 'function') return;
            try {
                onInteractionResponse(payload);
            } catch (_) {
                // Observing the reply must never stop the reply being sent.
            }
        }
    };

    const channel = makeChannelProxy(interaction, state);
    const mentions = makeMentionsProxy(interaction);

    return {
        // Identity
        author: interaction.user,
        member: interaction.member,
        channel,
        guild: interaction.guild,
        client: interaction.client,
        mentions,
        content: config.commandPrefix + interaction.commandName + (queryString ? ' ' + queryString : ''),

        // Reply method routes the same way channel.send does (first → editReply, rest → channel.send).
        async reply(payload) {
            const opts = typeof payload === 'string' ? { content: payload } : payload;
            if (!state.firstResponseSent) {
                state.firstResponseSent = true;
                state.report(opts);
                return interaction.editReply(opts);
            }
            return interaction.channel.send(opts);
        },

        // Expose the raw interaction for commands that want to read typed options directly
        // (e.g. interaction.options.getUser('user') for a USER-type option).
        interaction
    };
}

module.exports = { adaptInteraction };
