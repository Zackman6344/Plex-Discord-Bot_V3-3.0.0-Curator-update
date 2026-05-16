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
| `plexClient.js`            | Memoized Plex client. `getPlex()` returns a single shared `PlexAPI` instance.                                                          |
| `aiErrorHandler.js`        | `handleAIError(err, statusMsg, defaultMsg)` for AI commands; replies with an inferred reason (503 / 429 / bad key / 404 / network / SyntaxError) or the command-specific fallback. Also exports `inferReason(err)` as a pure function. |
| `clueCache.js`             | Persistent XML clue cache for AI minigames. `getOrGenerate(media, minigame, fn, model)` checks `data/clues/<slug>-<year>.xml` first; on miss runs `fn` and appends the result as a new variant. Multiple variants per (media, minigame) accumulate; lookups pick one at random. See "AI clue cache" section below. |
| `healthCheck.js`           | Validates config + tries each integration (Plex/Gemini/Tautulli/Playnite). Returns a structured `{config, plex, gemini, tautulli, playnite}` result. Used by `!diag` and the boot monitor. |
| `healthMonitor.js`         | Runs `runHealthCheck()` at boot + every 15 minutes. Logs status transitions and DMs the owner (if `config.ownerId` is set) on any change. |
| `tautulliAPI.js`           | Wraps the Tautulli HTTP API. Currently exposes `getLibraryStats()`. Disabled unless `config.tautulliEnabled`.                          |
| `playniteAPI.js`           | Wraps the local Playnite HTTP server (port 8787). Exposes `getLibrary()`, `searchGame(q)`, `launchGame(id)`, `getStats()`. Disabled unless `config.playniteEnabled`. |
| `aiGameRecommender.js`     | "Pick a game" AI helper. Uses centralized `getModel()`. Powers `!pickgame`.                                                            |
| `aiCharacterMapper.js`     | Maps gaming/media habits to a D&D class. Uses centralized `getModel()`. Powers `!buildcharacter`.                                      |
| `characterStorage.js`      | Persists character sheets to `data/characters.json`. Used by `!buildcharacter` and `!mysheet`.                                          |
| `compendiumProvider.js`    | Loads `compendium/FightClub5e.xml` on first access; exposes class/spell/item lookups for the D&D commands.                              |

---

## Configuration

Three files in `config/`. The two with secrets are **gitignored**; templates are committed as `.example.js`.

| File                   | Tracked? | What it holds                                                              |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `config/config.js`     | yes      | Feature flags + display strings: `commandPrefix`, `listenChannel`, `playlistsDir`, `serverName`, `ownerId`, `launchRoleId`, `playniteEnabled`, `tautulliEnabled` + `tautulliApiKey` + `tautulliUrl`, `language`, `youtube_quality`. |
| `config/keys.js`       | **no**   | `botToken` (Discord) + `geminiApiKey` (Gemini). Copy from `keys.example.js`. |
| `config/plex.js`       | **no**   | Plex `hostname`, `port`, `https`, `token`, `managedUser`, `options`. Copy from `plex.example.js`. |

The boot health check validates the critical keys in `config.js` (`commandPrefix`, `language`, `serverName`, `playlistsDir`) and prints a loud warning if any are missing.

---

## Data & state

All persistent runtime state lives under `data/`. The directory is created if missing (the `.gitkeep` keeps it present even when empty).

| File                              | Written by                          |
| --------------------------------- | ----------------------------------- |
| `data/playtime_stats.json`        | (gaming tracker — feeds `!profile`) |
| `data/character_sheets.json`      | `commands/profile.js`               |
| `data/characters.json`            | `helpers/characterStorage.js` (used by `!buildcharacter`/`!mysheet`) |
| `data/plex_requests.json`         | `commands/request.js`               |
| `data/hitster_stats.json`         | `commands/hitster.js`               |
| `data/trivia_leaderboard.json`    | `commands/trivia.js`                |
| `data/badplot_leaderboard.json`   | `commands/badplot.js`               |
| `data/castingcouch_leaderboard.json` | `commands/castingcouch.js`       |
| `data/bard_leaderboard.json`      | `commands/quotethebard.js`          |
| `data/rumor_leaderboard.json`     | `commands/rumor.js`                 |
| `data/reviewbomb_leaderboard.json` | `commands/reviewbomb.js`           |
| `data/survival_<category>_leaderboard.json` | `commands/releasesurvival.js` |

Custom user playlists are separate — they live in `playlists/<name>.playlist` (gitignored). On-disk shape uses legacy French keys (`musiques`, `nom`, `titre`, `artiste`, `cle`) for backward compatibility with older playlist files; code reads/writes them using English variable names internally.

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

## Adding a new command

1. Drop a new file in `commands/<name>.js`.
2. Export `{ name, command: { usage, description, process } }` (and optionally `aliases: [...]`).
3. The boot loader picks it up automatically — no registration needed.
4. Inside `process`, call `bot.X()` methods, `bot.plex.query(...)`, `bot.songQueue.push(...)`, etc.
5. For AI commands: import `getModel` from `helpers/geminiAPI.js`. Don't construct your own `GoogleGenerativeAI`.
6. For error replies on AI commands: wrap your AI call in try/catch and pass to `helpers/aiErrorHandler.js`.
7. Add the command to `commands/help.js`'s embed text so it shows up in `!help`.

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
