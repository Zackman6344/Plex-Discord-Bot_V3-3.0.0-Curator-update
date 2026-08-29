# Architecture Overview

One-page reference for what's in this codebase, where it lives, and how it fits together. Read this before diving into individual files.

This is a Discord bot that wraps a Plex Media Server, ties in optional integrations (Tautulli for stats, Playnite for PC game data), and uses Google Gemini for AI-driven commands (trivia games, recommendations, D&D character sheets, etc.). It runs on Node.js 18+ and is intended to be self-hosted alongside a Plex install.

---

## Repository layout

| Directory       | What's in it                                                                 |
| --------------- | ---------------------------------------------------------------------------- |
| `index.js`      | Entry point. Five lines: imports `app/utils.js` and calls `start()`.         |
| `app/`          | Process lifecycle, Discord client setup, the `Bot` class, message dispatch. |
| `commands/`     | One file per Discord command. Auto-loaded by `commands/index.js`.            |
| `commands/playlist.js/` | Sub-commands of `!playlist` (it's a directory named `*.js` — see Quirks). |
| `helpers/`      | Shared utilities: API clients, Gemini wrapper, logger, health check, etc.    |
| `config/`       | Config files (`config.js`, `keys.js`, `plex.js`) + `.example.js` templates.  |
| `lang/`         | Localized message strings + the `String.prototype.format` polyfill.          |
| `data/`         | Persistent state files (leaderboards, character sheets, playtime, requests). |
| `playlists/`    | User-created custom playlists (one `.playlist` JSON file per playlist).      |
| `test/`         | Smoke tests for helpers. Run with `npm test`.                                |
| `compendium/`   | (Optional) Houses `FightClub5e.xml` for the D&D character commands.          |

---

## Boot sequence

When you run `node index.js`:

1. `index.js` requires `app/utils.js` and calls `start()`.
2. `start()` creates the Discord `Client` with the needed gateway intents (`Guilds`, `GuildMessages`, `GuildVoiceStates`, `MessageContent`, `DirectMessages`) and `Channel`/`Message` partials for DMs.
3. Constructs a `new Bot(client)` (`app/bot.js`). The Bot's constructor instantiates the Plex API client and initializes empty state (`songQueue`, `cache_library`, etc.).
4. Calls `require('./music.js')(client, bot)`. This:
   - Requires `commands/` (the loader runs and logs `Loaded N commands (M aliases)`).
   - Registers the `clientReady` and `messageCreate` event handlers.
5. Installs `uncaughtException` / `unhandledRejection` handlers (log only, don't exit).
6. Installs `SIGTERM` / `SIGINT` handlers for graceful shutdown.
7. Calls `client.login(keys.botToken)`. Discord login is async.
8. On `clientReady` (Discord ready), `app/music.js` calls `startHealthMonitor(client)`, which runs an initial health check and schedules re-checks every 15 minutes.
9. Still on `clientReady`, `app/music.js` calls `startEventServer(client)` (`helpers/eventServer.js`). When `config.eventServerEnabled` is true it opens a localhost-only HTTP listener that relays Kometa run + Playnite game-launch pushes to the broadcast channel; otherwise it logs "disabled" and no-ops.
10. Then `app/music.js` calls `startGamePresence(client)` (`helpers/gamePresence.js`) — when `config.gamePresenceEnabled` is true it subscribes to `presenceUpdate` and broadcasts games the owner starts (detected via Discord activity). No-op otherwise. The `GuildPresences` intent it needs is added in `app/utils.js` only when the flag is on, so the default keeps login working.
11. `app/music.js` calls `startKometaTheater(client)` (`helpers/kometaTheater.js`) — when `config.kometaTheaterEnabled` is true it starts tailing `config.kometaLogPath` to narrate Kometa runs in-character (and `broadcast.broadcastKometaRun` routes run boundaries + changes to it instead of factual cards). No-op otherwise.
12. `app/music.js` calls `startArchipelagoMonitor(client)` (`helpers/archipelagoMonitor.js`), which reopens any saved Archipelago watches. Returns immediately when `config.archipelagoEnabled` is false, which is the default.
13. Finally `app/music.js` calls `broadcast.broadcastStartup(client)` — when `config.broadcastStartup` is true it posts a "System has started" card to a single channel (the general `broadcastChannelId`, else the first configured channel), confirming the bot is live and the listener is bound. No-op when the toggle is off or no channel is set.

A clean boot looks like:
```
INFO  Loaded 51 commands (2 aliases)
INFO  Bot ready — logged in as <BotName>
INFO  Boot health check:
  ✓ Config: all required keys present
  ✓ Plex: <ServerName> v...
  ✓ Gemini: API key present
  − Tautulli: disabled
  − Playnite: disabled
  − EventServer: disabled
INFO  Health monitor scheduled — re-checking every 15 minutes
```

---

## The Bot class (`app/bot.js`)

A single `Bot` instance is created at startup. It extends `EventEmitter` and owns:

- **Plex client** — `this.plex`, a `PlexAPI` instance. Used for queries against the Plex server (`this.plex.query(path)`).
- **Audio state** — `this.songQueue`, `this.isPlaying`, `this.isPaused`, `this.dispatcher` (the `@discordjs/voice` AudioPlayer), `this.voiceChannel`, `this.conn`.
- **Pagination state** — `this.plexQuery`, `this.plexOffset`, `this.plexPageSize`, `this.tracks` (last search results).
- **Library cache** — `this.cache_library` keyed by Plex section key.
- **Concurrency control** — `this.workingTask` semaphore + `this.waitForStart` flag, used to serialize song additions while audio is being prepared.

Commands receive `bot` as their first arg and call methods on it (`bot.findSong(...)`, `bot.songQueue.push(...)`, `bot.playSong(message)`, etc.).

---

## Command system

### Loader (`commands/index.js`)

Reads every `*.js` file in `commands/` at startup. Each file is expected to export:

```js
module.exports = {
  name: 'play',                  // primary invocation name (used as !play)
  aliases: ['p'],                // optional — additional invocation names
  command: {
    usage: '<song>',             // shown in error replies / help
    description: 'Play a song.', // shown in help
    process: async function(bot, client, message, query) { ... }
  }
};
```

The loader registers `module.exports[name]` and `module.exports[alias]` to point at `command`. Failures during `require()` are caught and logged as `❌ Failed to load command file "X.js": <error>`, so a single broken command doesn't take down the bot.

### Dispatcher (`app/music.js`)

On every `messageCreate`:

1. Check if the message starts with `config.commandPrefix` (default `!`).
2. Check the channel matches `config.listenChannel` if set.
3. Strip the prefix, lowercase the first word, look it up in the command registry.
4. Call `cmd.process(bot, client, message, query)`. Sync throws are caught and logged.

### Command file patterns

Two signature styles coexist in the codebase:

- **Old style** (most commands): `function(bot, client, message, query)`. The dispatcher passes all four positionally.
- **New style** (AI commands): `function(...args)` plus a defensive scan for the message object. This pattern exists because some AI commands were written defensively; the args are always passed positionally though, so the scan is technically unnecessary.

---

## Helpers (`helpers/`)

| File                       | Role                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `logger.js`                | Tiny no-deps leveled logger (`debug`/`info`/`warn`/`error`) with ISO timestamps. Level set via `LOG_LEVEL` env var. Default: `info`.    |
| `geminiAPI.js`             | Centralized Gemini SDK. Exports `DEFAULT_MODEL`, `getGenAI()`, `getModel(options?)`, and `generateCharacterSheet(...)`. **Single place to change the model name.** |
| `plexClient.js`            | Memoized Plex client. `getPlex()` returns a single shared `PlexAPI` instance for the bot's *default* account.                          |
| `plexHome.js`              | Handles Plex Home managed-user switching for the `!playlist plex-copy` / `plex-list <user>` flows. Uses `plexConfig.homeOwnerToken` against plex.tv's `/api/v2/home/users/<id>/switch` endpoint; caches switched clients in memory by `(discordUserId, plexUsername)` for 30 minutes. See "Plex multi-account auth" below. |
| `slashRegistry.js`         | Collects each command's `slash` metadata (if declared), builds Discord ApplicationCommand JSON, registers with Discord on boot. Per-guild when `config.testGuildId` is set, global otherwise. Also exports `buildQueryString(interaction, slashSpec)` for the dispatcher. |
| `interactionAdapter.js`    | Wraps a Discord `ChatInputCommandInteraction` to look like a `Message` so existing command process functions work unchanged against slash commands. First `.reply()` / `.channel.send()` routes through `interaction.editReply()`; subsequent calls use the real channel. See "Slash commands" below. |
| `aiErrorHandler.js`        | `handleAIError(err, statusMsg, defaultMsg)` for AI commands; replies with an inferred reason (503 / 429 / bad key / 404 / network / SyntaxError) or the command-specific fallback. Also exports `inferReason(err)` as a pure function. |
| `clueCache.js`             | Persistent XML clue cache for AI minigames. `getOrGenerate(media, minigame, fn, model)` checks `data/clues/<slug>-<year>.xml` first; on miss runs `fn` and appends the result as a new variant. Multiple variants per (media, minigame) accumulate; lookups pick one at random. See "AI clue cache" section below. |
| `commandLog.js`            | Structured JSONL record of every command invocation, its outcome and the bot's replies, in `data/logs/commands-<date>.jsonl`. Secrets redacted, 14-day retention, `npm run logs` reads it back. |
| `selection.js`             | The probabilistic bits of queue assembly: `discoveryQuota()` (stochastic rounding, so a percentage setting behaves at small queue sizes) and `weightedShuffle()` (stronger tag matches surface near the front without being guaranteed a slot). Pure, with an injectable RNG. |
| `plexTags.js`              | Plex mood/genre/style vocabulary + server-side tag filtering. Plex never returns Mood/Style inline on a track in a *section listing* — only `/library/metadata/<key>` carries them — so tag search must go through the section's tag filters. Exports `getVocabulary()`, `fetchTracksByTags()`, `fetchTracksByRatingKeys()`, `countTracks()`, `sampleRandomTracks()`. |
| `tagSidecar.js`            | Local store of **approved, AI-inferred** track tags filling the gap where Plex has none (~70% of tracks here). Plex always wins per dimension; an inferred dimension Plex later fills is marked `supersededAt` rather than deleted. Atomic writes, persisted pending proposals, and the `discoveryPercent` / `repeatMemory` tuning. Writes `data/inferred_tags.json`. Never writes to Plex. |
| `tagInference.js`          | Asks Gemini to fill only the dimensions Plex is missing, constrained to the library's own vocabulary, and renders the approval card. Nothing is stored without a human clicking Approve; the handler answers every click through an update → reply → followUp → channel fallback chain and leaves the proposal live if the disk write fails. |
| `recentPicks.js`           | Short memory of tracks already served, so a library's well-tagged minority doesn't monopolise every AI-curated queue. A score *handicap*, not a ban. Writes `data/recent_picks.json`. |
| `healthCheck.js`           | Validates config + tries each integration (Plex/Gemini/Tautulli/Playnite). Returns a structured `{config, plex, gemini, tautulli, playnite}` result. Used by `!diag` and the boot monitor. |
| `healthMonitor.js`         | Runs `runHealthCheck()` at boot + every 15 minutes. Logs status transitions and DMs the owner (if `config.ownerId` is set) on any change. |
| `tautulliAPI.js`           | Wraps the Tautulli HTTP API. Currently exposes `getLibraryStats()`. Disabled unless `config.tautulliEnabled`.                          |
| `playniteAPI.js`           | Wraps the local Playnite HTTP server (port 8787). Exposes `getLibrary()`, `searchGame(q)`, `launchGame(id)`, `getStats()`. Disabled unless `config.playniteEnabled`. |
| `eventServer.js`           | Localhost-only inbound HTTP listener (`config.eventServerPort`, default 8799). `POST /kometa` and `POST /playnite/start` relay to the broadcast channel; `GET /health` is a ping. Optional `?token=` check. Disabled unless `config.eventServerEnabled`. See "Broadcasts" below. |
| `broadcast.js`            | Builds + sends the broadcast embeds. Pure builders `buildKometaEmbed` / `buildKometaChangesEmbed` / `buildGameLaunchEmbed` / `buildGamePresenceEmbed` / `buildStartupEmbed` + `pickChannelId(type)` / `startupChannelId()` / `isNoteworthyChange(payload)` (all unit-tested); senders route Kometa → `kometaChannelId` and game launches → `gameLaunchChannelId` (each falling back to `broadcastChannelId`), gate `changes` events through the noteworthy filter, attach Playnite cover art, and swallow send failures. `broadcastStartup(client)` posts a boot confirmation to a single channel. |
| `gamePresence.js`         | Launcher-agnostic game-launch detection via Discord activity. `startGamePresence(client)` watches `presenceUpdate` for the owner and broadcasts newly-started `Playing` games (pure `startedGames(prev, activities)` diff, unit-tested). No-op unless `config.gamePresenceEnabled` (which also gates the privileged `GuildPresences` intent in `app/utils.js`). |
| `kometaTheater.js`        | "Silly mode" that narrates a Kometa run in-character. Tails `meta.log` for per-collection coverage (single-pattern `parseFinishedCollection`) + `changes` webhooks (fed via `onChanges`) for detail; a paced worker posts per-collection persona dialogue (fast Gemini, persisted per name) or garbled `buildStaticText` for unseen+unadded collections. Pure `parseFinishedCollection`/`normalizeName`/`classifyKind`/`buildStaticText` unit-tested. No-op unless `config.kometaTheaterEnabled`. See "Kometa Theater" below. |
| `configStore.js`          | Backing store + schema for the `/config` wizard. Holds the editable `SETTINGS` list, pure `formatValue`/`validate` helpers (unit-tested), and `readOverrides`/`writeOverride`/`removeOverride`. Writes `data/config.overrides.json` and mutates the live config object so most changes apply without a restart. No discord.js. See "In-Discord config wizard" below. |
| `archipelagoClient.js`     | One read-only WebSocket connection to an Archipelago multiworld. Runs the `RoomInfo` → `GetDataPackage` → `Connect` handshake, resolves item/location/player ids to names, renders `PrintJSON` packets into log lines, reconnects with backoff. Also exports the pure `parseTarget()`, `extractConnectAddress()` and `renderPrintJSON()`. |
| `archipelagoData.js`       | Disk cache for AP data packages under `data/archipelago/datapackage/`, keyed by the per-game checksum the server publishes in `RoomInfo`. A reconnect re-downloads only the games whose checksum moved. |
| `archipelagoMonitor.js`    | Holds one client per watched room, batches its log lines, posts them to the channel the watch was created in. Watches persist to `data/archipelago_watches.json` and reopen on boot. Disabled unless `config.archipelagoEnabled`. See "Archipelago room monitor" below. |
| `aiGameRecommender.js`     | "Pick a game" AI helper. Uses centralized `getModel()`. Powers `!pickgame`.                                                            |
| `aiCharacterMapper.js`     | Maps gaming/media habits to a D&D class. Uses centralized `getModel()`. Powers `!buildcharacter`.                                      |
| `characterStorage.js`      | Persists character sheets to `data/characters.json`. Used by `!buildcharacter` and `!mysheet`.                                          |
| `compendiumProvider.js`    | Loads `compendium/FightClub5e.xml` on first access; exposes class/spell/item lookups for the D&D commands.                              |

---

## Configuration

Three files in `config/`. The two with secrets are **gitignored**; templates are committed as `.example.js`.

| File                   | Tracked? | What it holds                                                              |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `config/config.js`     | yes      | Feature flags + display strings: `commandPrefix`, `listenChannel`, `playlistsDir`, `serverName`, `ownerId`, `launchRoleId`, `playniteEnabled`, `tautulliEnabled` + `tautulliApiKey` + `tautulliUrl`, `language`, `youtube_quality`, the broadcast block (`broadcastChannelId`, `eventServerEnabled`, `eventServerPort`, `eventServerToken`, `broadcastKometa`, `broadcastGameLaunch`), and `archipelagoEnabled` + `archipelagoBatchSeconds`. |
| `config/keys.js`       | **no**   | `botToken` (Discord) + `geminiApiKey` (Gemini). Copy from `keys.example.js`. |
| `config/plex.js`       | **no**   | Plex `hostname`, `port`, `https`, `token` (the bot's default user), `homeOwnerToken` (optional, only for cross-account playlist features), `managedUser`, `options`. Copy from `plex.example.js`. |

The boot health check validates the critical keys in `config.js` (`commandPrefix`, `language`, `serverName`, `playlistsDir`) and prints a loud warning if any are missing.

**Runtime overrides.** `config/config.js` defines its values as a `defaults` object, then merges
`data/config.overrides.json` (if present) over them on load, applying only keys that already
exist in `defaults`. That overrides file is written by the `/config` wizard (`helpers/configStore.js`).
Because `bot.config` is the *same* object as `require('config/config.js')` and consumers read
`config.X` at call time, the wizard mutating that object takes effect live for most settings; the
JSON file makes the change durable across restarts. A missing/malformed overrides file is ignored.

---

## Data & state

All persistent runtime state lives under `data/`. The directory is created if missing (the `.gitkeep` keeps it present even when empty).

| File                              | Written by                          |
| --------------------------------- | ----------------------------------- |
| `data/playtime_stats.json`        | (gaming tracker — feeds `!profile`) |
| `data/character_sheets.json`      | `commands/profile.js`               |
| `data/characters.json`            | `helpers/characterStorage.js` (used by `!buildcharacter`/`!mysheet`) |
| `data/plex_requests.json`         | `commands/request.js`               |
| `data/inferred_tags.json`         | `helpers/tagSidecar.js` (approved inferred tags + pending proposals + tuning; documented, stable shape for use outside the bot) |
| `data/inferred_tags.export.json`  | `commands/tags.js` (`/tags export` — portable copy including file paths) |
| `data/recent_picks.json`          | `helpers/recentPicks.js`            |
| `data/logs/bot-<date>.log`        | `helpers/logger.js` (console mirror) |
| `data/logs/commands-<date>.jsonl` | `helpers/commandLog.js` (invocations, outcomes, outputs) |
| `data/hitster_stats.json`         | `commands/hitster.js`               |
| `data/trivia_leaderboard.json`    | `commands/trivia.js`                |
| `data/badplot_leaderboard.json`   | `commands/badplot.js`               |
| `data/castingcouch_leaderboard.json` | `commands/castingcouch.js`       |
| `data/bard_leaderboard.json`      | `commands/quotethebard.js`          |
| `data/rumor_leaderboard.json`     | `commands/rumor.js`                 |
| `data/reviewbomb_leaderboard.json` | `commands/reviewbomb.js`           |
| `data/survival_<category>_leaderboard.json` | `commands/releasesurvival.js` |
| `data/archipelago_watches.json`   | `helpers/archipelagoMonitor.js`     |
| `data/archipelago/datapackage/*.json` | `helpers/archipelagoData.js`    |

Custom user playlists are separate — they live in `playlists/<name>.playlist` (gitignored). On-disk shape uses legacy French keys (`musiques`, `nom`, `titre`, `artiste`, `cle`) for backward compatibility with older playlist files; code reads/writes them using English variable names internally.

### Slash commands

The bot supports both `!`-prefix and `/`-slash invocations for the same commands. Both paths dispatch through the same `plexCommands` map. The slash path is opt-in per command: any command that declares a `slash` block in its export becomes reachable via `/name`, while commands without one stay prefix-only.

**Per-command shape:**

```js
module.exports = {
    name: 'play',
    command: {
        usage: '<song>',
        description: 'Add a song to the queue',     // prefix help text
        slash: {                                    // optional — opt-in slash registration
            description: 'Add a song to the queue', // 1-100 chars, shown in Discord's UI
            options: [
                { name: 'song', type: 'STRING', description: 'Song name', required: false }
            ]
        },
        process: async function(bot, client, message, query) { ... }
    }
};
```

For subcommand patterns (e.g. `/playlist create`, `/playlist play`), use `subcommands` instead of `options`:

```js
slash: {
    description: 'Manage custom playlists',
    subcommands: [
        { name: 'create', description: 'Create a new playlist',
          options: [{ name: 'name', type: 'STRING', required: true, description: '...' }] },
        ...
    ]
}
```

**Boot-time registration.** On `clientReady`, `app/music.js` calls `slashRegistry.registerAll(client, plexCommands)`. The helper:
1. Walks the loaded commands, dedupes aliases by object identity, validates names against Discord's `^[\w-]{1,32}$` rule.
2. Builds Discord's `ApplicationCommand` JSON for each (mapping string type names like `'STRING'` to the numeric enum values discord.js expects).
3. If `config.testGuildId` is set, registers via `guild.commands.set()` (instant). Otherwise registers globally via `client.application.commands.set()` (up to 1 hour to propagate). Use the test-guild path during development to avoid the wait.

**Dispatch.** `app/music.js`'s `interactionCreate` handler:
1. Filters to chat-input commands only.
2. Looks up the command in `plexCommands` and confirms it has a `slash` block.
3. Calls `interaction.deferReply()` immediately (Discord's 3-second acknowledgement window). A command may set `slash.ephemeral: true` to defer privately (`flags: MessageFlags.Ephemeral`) — used by `/config` so the settings panel is only visible to the owner who ran it.
4. Builds a `query` string from the interaction's options, in the same shape the prefix dispatcher produces (so the existing parser code in each command works).
5. Wraps the interaction in `interactionAdapter.adaptInteraction()` → a Message-shaped facade.
6. Calls `cmd.process(bot, client, fakeMessage, query)` — same signature the prefix dispatcher uses.

**The adapter contract** (`helpers/interactionAdapter.js`): `message.content` is rebuilt in prefix form (`!name args`) rather than set to the bare argument string, because several commands parse arguments as `content.split(' ').slice(1)` and would otherwise lose the first one. The first call to `message.reply(...)` or `message.channel.send(...)` routes through `interaction.editReply(...)`, which appears in chat as the bot's response to the slash command. Subsequent calls go through the real `interaction.channel.send(...)`. That means commands like `!trivia` (which post a "Loading..." status, then edit it, then post game messages) work unchanged: the initial `channel.send` becomes the slash command's primary response, then the game's follow-up messages are normal channel posts.

**Coverage:** every command in `commands/` declares a `slash` block — 53 at the time of writing, including subcommand sets for `/playlist`, `/request`, `/hitster`, `/library`, `/list`, `/tags` and the game commands. `npm run check:slash` validates the whole set against Discord's rules without booting the bot.

**Option conventions.** Two beyond plain options:
- `flag: '-r'` on a BOOLEAN emits a literal token into the query string when true, so the `!`-prefix parser sees the argument shape it already understands (`/playlist play shuffle:True` → `play <name> -r`).
- `omitFromQuery: true` keeps an option out of the query string entirely, for commands that read it straight off the interaction — `/vibe`'s `ttrpg:` boolean does this.

**The trap.** A command that refuses to run without an argument must declare that argument as an option. This has shipped twice: the parser demanded input the slash spec gave no way to supply, so `/x` was permanently unusable while `!x` worked fine. `npm run check:slash` warns about exactly this case.

---

### Plex multi-account auth

The bot ships with a two-token model:

- **`plexConfig.token`** — the user the bot *acts as* by default. Used for library reads, audio playback, queue ownership. Recommended setup: create a PIN-less Plex Home managed user dedicated to the bot ("BotAccount" or similar), sign in as them once, and grab their token. This keeps the bot's watch history isolated and avoids contaminating the owner account.
- **`plexConfig.homeOwnerToken`** — your Plex Home OWNER token. Optional. Only used by `helpers/plexHome.js` when an explicit cross-account command is invoked.

Cross-account flow (used by `!playlist plex-copy` and `!playlist plex-list <username>`):

1. User invokes the command in a channel; bot opens a DM with them.
2. Bot calls `GET https://plex.tv/api/v2/home/users` with `homeOwnerToken` to enumerate managed users.
3. Bot asks the user which account they want, then DM-prompts for that user's PIN.
4. Bot calls `POST https://plex.tv/api/v2/home/users/<id>/switch?pin=<pin>` with `homeOwnerToken`. Plex returns a `authToken` scoped to that managed user.
5. Bot constructs a new `PlexAPI` client pointed at the local server, using the switched token.
6. The switched client is cached in memory by `(discordUserId, plexUsername)` for 30 minutes. Subsequent invocations from the same Discord user against the same managed user within that window skip the PIN prompt entirely.

Security shape:
- PINs are **never persisted**. They're prompted via DM, used immediately for the switch call, and dropped from memory after the request completes.
- Switched tokens live **only in process memory**. Process restart clears them.
- The cache is keyed by Discord user, so PIN entry by user A doesn't grant user B implicit access to that managed account.
- Without `homeOwnerToken` configured, cross-account commands degrade gracefully — the bot still works as its default user, the relevant commands just refuse with a clear "feature disabled" message.

### AI clue cache (`data/clues/`)

The AI minigames (`!trivia`, `!badplot`, etc.) cache their generated clues in `data/clues/<slug>-<year>.xml`. One XML file per media item, every minigame's clues for that item collected side-by-side, multiple variants per minigame accumulate over time. Sample:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<media>
  <title>The Matrix</title>
  <year>1999</year>
  <type>movie</type>
  <plexKey>/library/metadata/12345</plexKey>
  <minigames>
    <trivia>
      <variant>
        <generated>2026-05-16T11:45:58.944Z</generated>
        <model>gemini-2.5-flash</model>
        <data>
          <clue1>Vague clue about a guy who learns reality isn't real.</clue1>
          <clue2>Mention Neo learning kung fu via download.</clue2>
          <clue3>Bullet time and a red pill.</clue3>
        </data>
      </variant>
    </trivia>
    <badplot>
      <variant>...</variant>
    </badplot>
  </minigames>
</media>
```

Files are hand-editable. Delete a `<variant>` to retire a clue set; delete the whole file to force fresh generation next time the bot picks that media.

**Randomness contract (important):** the cache lookup runs *after* a minigame independently picks its target via uniform random sampling from the Plex library. The cache never influences which media gets chosen — its only job is to skip the Gemini call when we've already generated clues for that media. Cache-hit and cache-miss media are equally likely to be picked.

Wiring in a command is one block:

```js
const cacheTarget = { title: target.title, year: target.year, type: target.type, plexKey: target.key };
const clues = await clueCache.getOrGenerate(cacheTarget, 'trivia', async () => {
    const aiResult = await model.generateContent(prompt);
    const m = aiResult.response.text().match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Failed to parse AI JSON');
    return JSON.parse(m[0]);
}, DEFAULT_MODEL);
```

If the generator throws (e.g. a malformed Gemini response), nothing is written and the error bubbles up to the existing `handleAIError` flow. Successful generations append a new `<variant>` block; if cache writing itself fails (disk full, permissions), it's logged at WARN but the user's game still proceeds.

---

## In-Discord config wizard (`/config`)

`commands/config.js` is an **owner-only** wizard for editing `config/config.js` from Discord —
no file editing or restart needed for most settings.

- **UI.** An ephemeral panel: an embed of current values grouped by section, a menu to pick a
  section, then a menu of that section's settings. Picking one edits it via a **modal**
  (text/number), **buttons** (on/off), or a small **select** (choice like `youtube_quality`).
  Built with a message component collector + `awaitModalSubmit`, the same self-contained pattern
  as `commands/buildcharacter.js`, so the global `interactionCreate` handler needs no changes.
- **Panel limits.** Discord rejects a select carrying more than 25 options, and a message
  carrying more than 5 action rows, by refusing the whole payload rather than trimming it. Two
  earlier shapes both hit a ceiling: one flat menu died at 26 settings, and a menu per group
  died at the fifth group. The section-then-setting split has no such number, since only one
  group's settings are on screen at a time. `configStore.groupNames()` and `selectPages(group)`
  do the division; `test/configStore.test.js` asserts both limits and that every setting stays
  reachable.
- **Change hook.** `configStore.onChange(fn)` fires after a save is written and applied to the
  live config object. The Archipelago monitor subscribes so a new room, channel or filter takes
  effect on the next batch instead of the next boot.
- **Schema + persistence** live in `helpers/configStore.js`: the `SETTINGS` list (key, label,
  group, type, `secret`/`restartRequired`/`snowflake` flags, validators), pure `validate` /
  `formatValue`, and `writeOverride` (persists to `data/config.overrides.json` + mutates the
  live config object). See "Runtime overrides" under Configuration.
- **Security.** Owner-gated via `config.ownerId` (bootstrap: if `ownerId` is blank, the first
  caller may set it, then it locks to owner). Secret fields (`tautulliApiKey`,
  `eventServerToken`) are entered through a modal and **never displayed** (shown as `set`/`not set`).
  Tokens in `config/keys.js` / `config/plex.js` are intentionally **out of scope**.
- **Restart-scoped.** `eventServerEnabled` / `eventServerPort` only affect the already-bound
  listener at next boot; the panel labels these `(restart)`.

---

## Broadcasts (Kometa runs + Playnite game launches)

The bot can announce two kinds of on-machine events to a Discord channel. Both arrive by
**push** — the bot exposes a tiny inbound HTTP listener (`helpers/eventServer.js`) that
Kometa and Playnite POST to; the bot never polls.

```
Kometa   --webhook run_end/error-->  POST /kometa          ┐
                                                            ├─ eventServer ─> broadcast.js ─> channel embed
Playnite --"after starting" script-> POST /playnite/start  ┘
```

- **Listener.** Node core `http`, bound to `127.0.0.1` only (never reachable off the box).
  Enabled by `config.eventServerEnabled`; port from `config.eventServerPort` (default 8799).
  If `config.eventServerToken` is set, senders must pass `?token=<it>` or a `401` is returned.
  Body cap 64 KB; malformed JSON → `400`; unknown route → `404`. Listen failures (e.g. port
  in use) are logged and degrade the feature rather than crashing the bot.
- **Routing.** `POST /kometa` → `broadcast.broadcastKometaRun` (which applies the right per-event
  toggle: `config.broadcastKometa` for run summaries, `config.broadcastKometaChanges` for live
  changes); `POST /playnite/start` → `broadcast.broadcastGameLaunch` (gated by
  `config.broadcastGameLaunch`); `GET /health` → `{ ok: true }` for connectivity testing.
  Broadcasts fire-and-forget so a slow/failed Discord send never delays the HTTP response back to
  Kometa/Playnite.
- **Live Kometa changes.** Kometa's `changes` webhook fires once per collection/playlist during a
  run. `broadcastKometaRun` routes those to `buildKometaChangesEmbed` (added/removed titles,
  Radarr/Sonarr "requested for the server" items, collection poster), but only after
  `isNoteworthyChange(payload)` passes — created, has server requests, or grew by at least
  `config.kometaChangesMinAdds` (floored at 1, so pure removals never post). This keeps a big run
  from spamming every tiny tweak.
- **Startup confirmation.** On boot (`clientReady`), `broadcastStartup(client)` posts a "System has
  started" card — listing the event-listener status and which broadcasts are enabled — to a single
  channel (`startupChannelId()`: the general `broadcastChannelId`, else the first configured type
  channel). Gated by `config.broadcastStartup`.
- **Game-launch detection — two independent paths.** (1) The **Playnite script** POSTs to
  `/playnite/start` → `broadcastGameLaunch` (rich card w/ cover art, but only for Playnite-launched
  games). (2) **Discord activity** via `helpers/gamePresence.js` → `broadcastGamePresence` (works
  for any launcher Discord detects, e.g. Steam-direct; needs the privileged Presence Intent + a
  restart). Both post to the game channel; enabling both can double-post a Playnite launch.
- **Embeds.** `helpers/broadcast.js` maps the Kometa webhook JSON (`run_time`,
  `collections_*`, `items_*`, `added_to_radarr/sonarr`; `error`/`run_start` also handled) and
  the Playnite payload (`name`, `source`, `platform`, `cover`) to embeds. Kometa runs post to
  `config.kometaChannelId` and game launches to `config.gameLaunchChannelId`, each falling back
  to `config.broadcastChannelId` when its dedicated channel is blank (`pickChannelId(type)`).
  For game launches, `cover` is an absolute path the Playnite
  script resolves via `$PlayniteApi.Database.GetFullFilePath(...)`; the bot validates it
  (image extension, exists, size cap) and attaches it as the embed thumbnail, falling back to
  a text-only embed otherwise. Everything no-ops (with a one-time WARN) when
  `broadcastChannelId` is blank.

### Host-side setup (`scripts/`)

These are **not** run by the bot — the user runs them once on the host, in the main install dir:

- `start-bot.vbs` — launches `node index.js` hidden (no console), cwd = repo root resolved
  relative to the script, output appended to `bot.log`.
- `install-startup-shortcut.ps1` / `uninstall-startup-shortcut.ps1` — add/remove a shortcut to
  `start-bot.vbs` in the Windows Startup folder so the bot launches at login.
- `playnite-game-start.ps1` — the snippet to paste into Playnite → Settings → Scripts →
  "Execute script after starting a game". POSTs the launched game to `POST /playnite/start`.

Kometa is pointed at the listener from its own `config.yml`:

```yaml
settings:
  webhooks:
    run_end: http://127.0.0.1:8799/kometa?token=YOUR_TOKEN
    error:   http://127.0.0.1:8799/kometa?token=YOUR_TOKEN
    changes: http://127.0.0.1:8799/kometa?token=YOUR_TOKEN
```

### Kometa Theater (`helpers/kometaTheater.js`)

Opt-in "silly mode" (`config.kometaTheaterEnabled`) that narrates a run in-character instead of the
factual change cards. It **replaces** the `changes`/`run_*` cards while on (`broadcastKometaRun`
routes those events into the theater via `onChanges`/`onRunStart`/`onRunEnd`).

- **Hybrid inputs.** Kometa's `changes` webhook only reports *changed* collections, so it can't see
  the ones that pass through unchanged. The theater tails **`meta.log`** for coverage — one clean
  `Finished <Name> Collection` line per collection (incl. unchanged) — and uses the buffered
  `changes` webhooks for the add/remove detail. Correlated by `normalizeName`; a short grace period
  before each post lets the matching webhook arrive.
- **Classification** (`classifyKind(isSeen, hasAdditions)`): unseen **and** gained nothing → garbled
  `buildStaticText` (no Gemini); otherwise it "reports in" — a brand-new collection with items
  introduces itself, an established one just reports (commenting on changes when present).
- **Personas** are per-collection-name, minted once via a fast model (`config.kometaTheaterModel`
  → `getModel`) and persisted in `data/kometa_theater.json` alongside the `seen` set. Gemini and
  Discord failures fall back to templated text; a parse error can't crash the bot.
- **Pacing**: a self-scheduling worker drains one collection every `config.kometaTheaterDelayMs`
  (the deliberate Discord-side slowdown). No cap — bounded by the number of collections processed.
- **Log tailer**: polls the file, seeks to EOF at boot (only new lines), handles rotation
  (`size < offset` → reset), decodes UTF-8 via `StringDecoder`, read-only.

**Brittleness (accepted):** depends on Kometa's log wording (`Finished (.+?) Collection`). Isolated
to one regex; degrades to fewer lines rather than failing.

---

## Archipelago room monitor

There are two ways to point the bot at a multiworld, and they run side by side.

**From `/config` → Archipelago.** Sixteen settings describe one room: where it is (`archipelagoRoomUrl`, or `archipelagoHost` + `archipelagoPort`), which slot to observe from, its password, which channel the log goes to, and the category filters. The monitor rebuilds that watch whenever any of them is saved, so a room can be swapped without touching the command line or restarting.

**From `!ap watch <room url|host:port> <slot name>`,** which binds a room to the channel the command was run in and persists it to the watch file.

Off by default either way: `archipelagoEnabled` gates both.

### The configured room

The config-defined room holds the reserved watch id `0` and is marked `managed`. Three consequences:

- It is **never written to `data/archipelago_watches.json`**. It is derived from config on every change, so a stored copy would go stale the moment a setting moved. `!ap watch` rooms number from 1 and cannot collide with it.
- `!ap unwatch 0`, `filter`, `password` and `progression` **refuse** and point at `/config`, because the next config change would silently undo them.
- It only exists once `archipelagoChannelId`, a target, and `archipelagoSlot` are all set. `configGaps()` names whatever is still missing, and both `!ap list` and `!diag` report it.

`syncConfigWatch()` decides whether a change costs a reconnect. Target, slot, password and the DeathLink tag are read during the connect handshake, so those rebuild the socket. Filters, the progression toggle, the batch window and the channel apply to the next batch on the existing connection.

### How the log is read

The web host serves a room's log at `/log/<room>`, gated on the room owner's browser session (`room.owner == session["_id"]`, otherwise `403`). Scraping it needs a cookie that expires, only ever covers rooms you own, and hands back text that has to be re-parsed. **The bot connects to the game server instead**, speaking the AP network protocol over a WebSocket, and receives the same events as structured packets. That path is identical for archipelago.gg and for a self-hosted server.

`PrintJSON` packets arrive as a list of parts where ids stand in for names, so rendering a line is a concatenation plus three lookups: player slot to name from `Connected.players`, item and location ids to names from the game's data package.

### The observer contract

The `Connect` handshake sends `game: ""`, `items_handling: 0`, `slot_data: false` and the `Tracker` tag. The server forwards no items and expects no location checks, so attaching to a slot leaves the person playing it untouched. AP permits many clients on one slot, which is how the stock text client rides along beside a game client.

`test/archipelagoConnect.test.js` asserts those four fields on the wire against a loopback server. A change there stops the bot being an observer of the slot it attaches to.

### Two visible side effects

- The room sees a client join on the watched slot, and it shows in everyone's log.
- Holding the socket open stops a hosted room idling to sleep. Resolving a room URL fetches the room page, which is also what wakes a paused room.

### Ports move

A hosted room is assigned a new port every time it spins up. A watch created from a room URL therefore stores the URL and re-reads the `'/connect host:port'` line off the room page on every connection attempt, including reconnects. A watch created from a literal `host:port` skips the lookup and connects straight out.

Reconnect backoff runs 5s, 10s, 20s, 40s, 80s, 160s, then holds at 300s. A `ConnectionRefused` (bad slot name, bad password) is treated as fatal instead: the watch is marked paused and says so in the channel, because retrying cannot fix it.

### Batching and safety

Lines are collected for `archipelagoBatchSeconds` (default 5) and posted as one fenced block. A busy multiworld emits dozens of item sends a minute, which would hit Discord's per-channel rate limit and bury everything else in the channel. Three caps bound the damage from a burst: 1900 characters per message, 3 messages per flush with a "trimmed" note beyond that, and 500 buffered lines before the oldest are dropped.

Relayed text is untrusted: it comes from whoever is playing. Every post goes out with `allowedMentions: { parse: [] }`, and any ` ``` ` inside a log line is rewritten to `'''` so it cannot close the fence early and let the rest render as markdown.

### Filters

Seven categories. The configured room takes them from the `archipelagoShow*` settings; a `!ap watch` room takes them from `!ap filter <id> <category> <on|off>`:

| Category | PrintJSON types |
| -------- | --------------- |
| `items`  | `ItemSend`, `ItemCheat` |
| `hints`  | `Hint` |
| `chat`   | `Chat`, `ServerChat` |
| `joins`  | `Join`, `Part`, `TagsChanged` |
| `goals`  | `Goal`, `Release`, `Collect` |
| `deaths` | DeathLink broadcasts |
| `misc`   | `Countdown`, `Tutorial`, `CommandResult`, `AdminCommandResult`, plain text, and any type added to the protocol later |

Everything except `deaths` is on by default. `!ap progression <id> on` narrows `items` to sends whose `NetworkItem.flags` carry the advancement bit, which is the usual fix for a noisy async.

`deaths` is separate because DeathLink arrives on `Bounced` rather than `PrintJSON`, and the server only routes those to clients advertising the `DeathLink` tag. Turning it on reconnects the watch so the tag is included in a fresh handshake. The bot never sends a death of its own.

### Data package caching

`RoomInfo` carries a checksum per game. Each is looked up in `data/archipelago/datapackage/<game>-<checksum>.json` first, and `GetDataPackage` is sent only for the games that missed. Some games ship id tables in the megabytes, and without the cache every reconnect would re-download all of them. Cache files are disposable; delete any and the next connect refetches it.

### Files

| File | Role |
| ---- | ---- |
| `commands/archipelago.js` | `!ap` / `/ap` (alias `!archipelago`). Subcommands: `watch`, `list`, `status`, `unwatch`, `filter`, `progression`, `password`, `retry`. Mutating subcommands are owner-only when `config.ownerId` is set. |
| `helpers/archipelagoClient.js` | Socket, handshake, reconnect, `PrintJSON` rendering. |
| `helpers/archipelagoMonitor.js` | Watch store, batching, Discord relay, status notices. |
| `helpers/archipelagoData.js` | Data package disk cache. |
| `data/archipelago_watches.json` | Watches added with `!ap watch`, never the configured room. Gitignored: it holds the room URL, the Discord channel and user ids, and a room password in plain text if one was set. Overridable with `PLEXBOT_AP_WATCHES_FILE`, which is required under the test runner so a test run cannot read or rewrite the real one. |

---

## Logging

Every log line goes through `helpers/logger.js`. Format:

```
[2026-05-16T10:44:27.633Z] INFO  Bot ready — logged in as ...
```

Levels: `debug`, `info`, `warn`, `error`. Set `LOG_LEVEL=debug` to surface the verbose Gemini debug output and other internal traces. Default is `info`.

Errors caught by the global `uncaughtException` / `unhandledRejection` handlers (`app/utils.js`) print at `ERROR` level but **do not exit the process** — the bot is intended to survive transient async errors.

---

## Testing

`npm test` runs Node's built-in test runner (`node --test test/*.test.js`). Smoke tests cover the helpers (logger, plexClient, geminiAPI, lang/format polyfill). They don't make network calls. Tests will fail if `config/keys.js` or `config/plex.js` are missing — copy from the `.example.js` files first.

---

## Quirks worth knowing

- **`commands/playlist.js/` is a directory** with `.js` in its name, not a file. The auto-loader's regex (`/\.js$/`) matches the directory name, and Node resolves the `require()` to `commands/playlist.js/index.js`. Clever but surprising; rename later if it becomes confusing.
- **The `Bot` class instantiates its own `PlexAPI`** in `app/bot.js`, separate from `helpers/plexClient.js`'s shared instance. Two TCP connection pools to the same Plex server. Legacy from before the helper existed; could be unified later.
- **`iceName` was a typo** in the Bot class's PlexAPI options — fixed in this iteration to `deviceName`. The Bot now identifies itself correctly to Plex.
- **`!youtube` works in two modes**: a URL plays directly; anything else hits `@distube/ytsr` for search and plays the top video result.
- **YouTube playback can break upstream** when YouTube rotates its player. The cure is `npm install @distube/ytdl-core@latest` (the fork ships patches fast). When it fails, the cipher-parse warnings appear in the log.
- **`config.managedUser` in `plex.js` is reserved** for a planned user-switching feature that isn't wired up yet.

---

## Tag search and the inferred-tag sidecar

The subsystem behind `/vibe` and `/tags`. Four facts about Plex drive the whole design:

1. A section listing (`/library/sections/<k>/all?type=10`) returns **no Mood and no Style** on
   tracks, whatever the library holds. Only `/library/metadata/<key>` carries them.
2. Those tags *do* exist as **filters**: `/library/sections/<k>/mood?type=10` lists the vocabulary
   (258 moods on the reference library), and `?mood=<key>` returns just its tracks, in
   milliseconds.
3. Most tracks have no mood data at all — roughly 70% on the reference library.
4. The full library is large (14k tracks / 19 MB), so pulling it per command is both slow and,
   because of (1), useless for tag matching.

The pipeline:

1. **Vocabulary** (`helpers/plexTags.js`) — the section's real mood/genre/style tags, cached for
   an hour.
2. **Mapping** — Gemini turns the user's request into tags **chosen from that closed list**, as
   many as genuinely fit. Unconstrained it invents plausible tags that match nothing, which is
   what made the original filter fall back to title substring matching.
3. **Retrieval** — one query per chosen tag; results are unioned, each track carrying the tags it
   actually matched. Ground truth, so the curator LLM downstream reasons about real metadata.
   The candidate list is then ordered by a weighted shuffle (`helpers/selection.js`): a track
   matching six requested moods reaches the front far more often than one matching a single mood,
   without ever being guaranteed a slot, so the same request twice does not return the same queue.
4. **Sidecar** (`helpers/tagSidecar.js`) — approved inferred tags are searched alongside Plex, so
   tracks Plex never tagged become reachable. Plex wins per dimension, always.
5. **Rotation + discovery** (`helpers/recentPicks.js`) — recent picks take a score handicap, and a
   configurable share of each queue is given to random untagged tracks, which then feed step 6.
6. **Review** (`helpers/tagInference.js`) — tags are proposed for queued tracks Plex has nothing
   for, and approved **one track at a time**. Approve writes that track immediately; reject writes
   nothing; feedback regenerates that track's suggestion and is remembered for later runs.

Nothing here writes to Plex. The store is `data/inferred_tags.json` (atomic writes, pending
reviews persisted so a restart doesn't strand a card), with `PLEXBOT_TAGS_FILE` overriding the
path for tests or an externally managed sidecar.

## Logging

Two sinks, both under `data/logs/`, both pruned at 14 days.

**`helpers/logger.js`** mirrors console output to `bot-YYYY-MM-DD.log`. Console-only logging meant
any failure nobody was watching scrolled past unrecoverably.

**`helpers/commandLog.js`** records structured JSON Lines: `invoke` (path, command, args, user,
channel), `outcome` (ok, ms, error stack) and `output` (what the bot posted). One object per line,
so a process killed mid-append costs one event rather than the file.

Wiring lives in `app/music.js`. Invocations are logged in all three dispatch paths — prefix, slash
and button. Output is captured once, in a `messageCreate` listener filtered to the bot's own
messages, rather than at the couple of hundred call sites that produce it; each is correlated to
whatever command last ran in that channel within a two-minute window. Correlation is best-effort
by design: a Kometa broadcast or a game timer arrives with no invocation attached, which is
exactly what it is, and `npm run logs` reports those separately.

Secrets discovered from `config/keys.js`, `config/plex.js` and `config/config.js` are redacted
before any line is written. Both sinks swallow their own write errors — a logger that throws is
worse than a logger that loses a line — and both honour env kill switches
(`PLEXBOT_COMMAND_LOG=0`, `PLEXBOT_LOG_TO_FILE=0`) plus `PLEXBOT_LOG_DIR` for redirection.

`scripts/logs.js` (`npm run logs`) folds the events back into one record per invocation and prints
them as a transcript, with `--errors`, `--command=`, `--user=`, `--since=`, `--n=`, `--stats` and
`--raw`.

## Adding a new command

1. Drop a new file in `commands/<name>.js`.
2. Export `{ name, command: { usage, description, process } }` (and optionally `aliases: [...]`).
3. The boot loader picks it up automatically — no registration needed.
4. Inside `process`, call `bot.X()` methods, `bot.plex.query(...)`, `bot.songQueue.push(...)`, etc.
5. For AI commands: import `getModel` from `helpers/geminiAPI.js`. Don't construct your own `GoogleGenerativeAI`.
6. For error replies on AI commands: wrap your AI call in try/catch and pass to `helpers/aiErrorHandler.js`.
7. Add a `slash` block. **If the command needs an argument, declare it as a required option** — otherwise the slash form has no field to type into and can never work. Check the spec against what `process` actually reads, in both directions: an option nothing consumes is as broken as a missing one.
8. Run `npm run check:slash`.
9. Add the command to `commands/help.js`'s embed text so it shows up in `!help`.

---

## Where each major feature lives

| Feature                          | Entry point                          | Helper(s)                                                   |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| Audio playback (Plex + YouTube)  | `app/bot.js` `playSong()`            | `@discordjs/voice`, `@distube/ytdl-core`, `node-fetch`      |
| YouTube search                   | `commands/youtube.js`                | `@distube/ytsr`                                             |
| Plex library search / queue      | `app/bot.js`                         | `plex-api`                                                  |
| Custom playlists                 | `commands/playlist.js/`              | `app/bot.js#addToPlaylist`                                  |
| AI trivia / minigames            | `commands/{trivia,badplot,...}.js`   | `helpers/geminiAPI.js` + `aiErrorHandler.js`                |
| Group / curator recommendations  | `commands/{curator,groupwatch,quest,identify,vibe,sonic}.js` | `helpers/geminiAPI.js` |
| Plex requests board              | `commands/request.js`                | `data/plex_requests.json`                                   |
| D&D character sheets             | `commands/{buildcharacter,mysheet,profile}.js` | `aiCharacterMapper.js`, `compendiumProvider.js`, `characterStorage.js` |
| Playnite game launching          | `commands/{game,launch,backlog,pickgame,stats}.js` | `helpers/playniteAPI.js`, `aiGameRecommender.js`    |
| Stats / diagnostic               | `commands/{stats,test}.js`           | `tautulliAPI.js`, `playniteAPI.js`, `healthCheck.js`        |
| Broadcasts (Kometa + game launch) | `helpers/eventServer.js` (inbound)  | `helpers/broadcast.js`; `scripts/` (autostart + Playnite hook) |
| In-Discord config wizard         | `commands/config.js`                 | `helpers/configStore.js`; `config/config.js` overrides layer |
