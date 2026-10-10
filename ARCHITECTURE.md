# Architecture Overview

One-page reference for what's in this codebase, where it lives, and how it fits together. Read this before diving into individual files.

This is a Discord bot that wraps a Plex Media Server, ties in optional integrations (Tautulli for stats, Playnite for PC game data), and uses Google Gemini for AI-driven commands (trivia games, recommendations, D&D character sheets, etc.). It runs on Node.js 18+ and is intended to be self-hosted alongside a Plex install.

---

## Repository layout

| Directory       | What's in it                                                                 |
| --------------- | ---------------------------------------------------------------------------- |
| `index.js`      | Entry point. Claims the single-instance lock, then calls `start()` from `app/utils.js`. |
| `app/`          | Process lifecycle, Discord client setup, the `Bot` class, message dispatch. |
| `commands/`     | One file per Discord command. Auto-loaded by `commands/index.js`.            |
| `commands/playlist.js/` | Sub-commands of `!playlist` (it's a directory named `*.js` — see Quirks). |
| `commands/book.js/` | `/book` and `!book`: `index.js` holds the slash spec, autocomplete and dispatch, and requires `play.js`, `controls.js`, `library.js` and `admin.js` by name. Same directory trick as `playlist.js/`. |
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

1. `index.js` claims the single-instance lock (`helpers/singleInstance.js`): a named pipe on Windows, an abstract socket on Linux, keyed by a hash of the bot token. If another copy already holds it, this one logs the holder's PID, exits with code 1 and never logs in. Otherwise it calls `start()` from `app/utils.js`.
2. `start()` applies the process priority (`helpers/processPriority.js`, `above_normal` by default, logged as `Process priority: <name>`) and switches the voice-health log on or off (`helpers/voiceHealth.js`, off by default). Both happen before the login so the first track already runs at the chosen priority, both subscribe to `/config` changes, and both are safe to repeat when `!restart` runs `start()` again. See "Voice health and process priority".
3. `start()` creates the Discord `Client` with the needed gateway intents (`Guilds`, `GuildMessages`, `GuildVoiceStates`, `MessageContent`, `DirectMessages`) and `Channel`/`Message` partials for DMs.
4. Constructs a `new Bot(client)` (`app/bot.js`). The Bot's constructor instantiates the Plex API client and initializes empty state (`songQueue`, `cache_library`, `books = null`, `loadingRuns = 0`, etc.).
5. Calls `require('./music.js')(client, bot)`. This:
   - Requires `commands/` (the loader runs and logs `Loaded N commands (M aliases)`).
   - Creates the audiobook director, `bot.books = createBookDirector({ client, bot })` (`helpers/bookEngine.js`). This happens at module init rather than on ready, because the music gate and `utils.stop()`'s shutdown both need it before the gateway is up. It reads nothing and opens nothing until a book is played.
   - Registers the `clientReady` and `messageCreate` event handlers.
6. Calls `client.login(keys.botToken)`. Discord login is async, so the next two steps run in the same tick, before the gateway answers.
7. Installs `uncaughtException` / `unhandledRejection` handlers (log only, don't exit).
8. Installs `SIGTERM` / `SIGINT` handlers for graceful shutdown. `utils.stop()` calls `bot.books.shutdown()` first, before the music queue is emptied: book saves are synchronous, and `process.exit` follows straight after.
9. On `clientReady` (Discord ready), `app/music.js` calls `startHealthMonitor(client)`, which runs an initial health check and schedules re-checks every 15 minutes.
10. Still on `clientReady`, `app/music.js` calls `startEventServer(client)` (`helpers/eventServer.js`). When `config.eventServerEnabled` is true it opens a localhost-only HTTP listener that relays Kometa run + Playnite game-launch pushes to the broadcast channel; otherwise it logs "disabled" and no-ops.
11. Then `app/music.js` calls `startGamePresence(client)` (`helpers/gamePresence.js`). When `config.gamePresenceEnabled` is true it subscribes to `presenceUpdate` and broadcasts games the owner starts (detected via Discord activity). No-op otherwise. The `GuildPresences` intent it needs is added in `app/utils.js` only when the flag is on, so the default keeps login working.
12. `app/music.js` calls `startKometaTheater(client)` (`helpers/kometaTheater.js`). When `config.kometaTheaterEnabled` is true it starts tailing `config.kometaLogPath` to narrate Kometa runs in-character (and `broadcast.broadcastKometaRun` routes run boundaries + changes to it instead of factual cards). No-op otherwise.
13. `app/music.js` calls `startArchipelagoMonitor(client)` (`helpers/archipelagoMonitor.js`), which reopens any saved Archipelago watches. Returns immediately when `config.archipelagoEnabled` is false, which is the default.
14. `app/music.js` calls `bot.books.start()`, which hands over to `helpers/bookLibrary.js`: read the stored catalog, rebuild it in the background if the library changed, and arm the hourly library check. Returns `null` and arms nothing while `config.audiobooksEnabled` is false, which is the default. If the setting is switched on later, the first `/book play` or `/book library` arms it.
15. Finally `app/music.js` calls `broadcast.broadcastStartup(client)`. When `config.broadcastStartup` is true it posts a "System has started" card to a single channel (the general `broadcastChannelId`, else the first configured channel), confirming the bot is live and the listener is bound. No-op when the toggle is off or no channel is set.

A clean boot looks like:
```
INFO  Process priority: above_normal
INFO  Loaded 56 commands (4 aliases)
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
- **The audiobook seam.** `this.books` is the book director, assigned by `app/music.js`. `this.loadingRuns` counts `playSong` calls in flight. `musicBusy()` says whether music owns, or is about to own, the bot's voice: `loadingRuns`, `waitForStart`, `workingTask`, a connection that is not destroyed, or `isPlaying`. `openConnection(channel)` takes the channel to join, so the book engine can join with it. The engine reads nothing else on the Bot apart from `songQueue.length`. See "Audiobooks and podcasts".

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
| `singleInstance.js`        | Refuses a second copy of the bot. `claim(token)` listens on a named pipe (Windows), an abstract socket (Linux) or a socket file in the temp dir, all named from a SHA-256 of the token; the OS drops it when the process dies, so a crash leaves no stale lock. A refused copy asks the holder for its PID over the same pipe and names it. Lock errors other than a live holder fail open with a warning. |
| `geminiAPI.js`             | Centralized Gemini SDK. Exports `DEFAULT_MODEL`, `getGenAI()`, `getModel(options?)`, and `generateCharacterSheet(...)`. **Single place to change the model name.** |
| `plexClient.js`            | Memoized Plex client. `getPlex()` returns a single shared `PlexAPI` instance for the bot's *default* account.                          |
| `plexHome.js`              | Handles Plex Home managed-user switching for the `!playlist plex-copy` / `plex-list <user>` flows. Uses `plexConfig.homeOwnerToken` against plex.tv's `/api/v2/home/users/<id>/switch` endpoint; caches switched clients in memory by `(discordUserId, plexUsername)` for 30 minutes. See "Plex multi-account auth" below. |
| `slashRegistry.js`         | Collects each command's `slash` metadata (if declared), builds Discord ApplicationCommand JSON, registers with Discord on boot. Per-guild when `config.testGuildId` is set, global otherwise. Also exports `buildQueryString(interaction, slashSpec)` for the dispatcher. |
| `interactionFallback.js`   | What to say when a slash command could not be acknowledged. The interaction's token is dead by then, so this posts an ordinary channel message; without it the user sees only Discord's "This interaction failed". |
| `interactionAdapter.js`    | Wraps a Discord `ChatInputCommandInteraction` to look like a `Message` so existing command process functions work unchanged against slash commands. First `.reply()` / `.channel.send()` routes through `interaction.editReply()`; subsequent calls use the real channel. See "Slash commands" below. |
| `aiErrorHandler.js`        | `handleAIError(err, statusMsg, defaultMsg)` for AI commands; replies with an inferred reason (503 / 429 / bad key / 404 / network / SyntaxError) or the command-specific fallback. Also exports `inferReason(err)` as a pure function. |
| `clueCache.js`             | Persistent XML clue cache for AI minigames. `getOrGenerate(media, minigame, fn, model)` checks `data/clues/<slug>-<year>.xml` first; on miss runs `fn` and appends the result as a new variant. Multiple variants per (media, minigame) accumulate; lookups pick one at random. See "AI clue cache" section below. |
| `commandLog.js`            | Structured JSONL record of every command invocation, its outcome and the bot's replies, in `data/logs/commands-<date>.jsonl`. Secrets redacted, kept indefinitely, `npm run logs` reads it back. |
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
| `kometaTheater.js`        | "Silly mode" that narrates a Kometa run in-character. Tails `meta.log` for per-collection coverage, the owning library, and missing counts, plus `changes` webhooks (fed via `onChanges`) for detail; a paced worker posts per-collection persona dialogue (fast Gemini, persisted per library+name) or garbled `buildStaticText` for unseen+unadded collections. Errors arrive via `onError` and are batched into the sign-off. Pure `parseFinishedCollection`/`parseProcessed`/`parseMissing`/`parseLibraryHeader`/`collectionKey`/`describeCompleteness`/`extractJsonObject`/`normalizeName`/`classifyKind`/`buildStaticText` unit-tested. No-op unless `config.kometaTheaterEnabled`. See "Kometa Theater" below. |
| `configStore.js`          | Backing store + schema for the `/config` wizard. Holds the editable `SETTINGS` list, pure `formatValue`/`validate`/`panelFields` helpers (unit-tested), and `readOverrides`/`writeOverride`/`removeOverride`. Writes `data/config.overrides.json` and mutates the live config object so most changes apply without a restart. No discord.js. See "In-Discord config wizard" below. |
| `archipelagoClient.js`     | One read-only WebSocket connection to an Archipelago multiworld. Runs the `RoomInfo` → `GetDataPackage` → `Connect` handshake, resolves item/location/player ids to names, renders `PrintJSON` packets into log lines, reconnects with backoff. Also exports the pure `parseTarget()`, `extractConnectAddress()` and `renderPrintJSON()`. |
| `archipelagoData.js`       | Disk cache for AP data packages under `data/archipelago/datapackage/`, keyed by the per-game checksum the server publishes in `RoomInfo`. A reconnect re-downloads only the games whose checksum moved. |
| `archipelagoMonitor.js`    | Holds one client per watched room, batches its log lines, posts them to the channel the watch was created in. Watches persist to `data/archipelago_watches.json` and reopen on boot. Disabled unless `config.archipelagoEnabled`. See "Archipelago room monitor" below. |
| `archipelagoTracker.js`    | Reads per-slot completion (`124/124`) off a room's multiworld tracker page, which is the only place a slot's total location count exists. Pure `extractTrackerId` / `parseTrackerRows` / `fullyCheckedSlots` plus one `readCompletion` fetch. Degrades to no information rather than throwing. `readProgress` takes every slot's checked locations and received items from one `/api/tracker` read, for `!ap next`. |
| `archipelagoLogic.js`      | Finds what `scripts/ap-logic-worker.py` needs for a seed (the install, its Python version, the output zip, and the seed number from Archipelago's Generate log as a spare), keeps one worker running at a time, and talks JSON lines to it. `acquire()` starts it lazily and remembers a failed start for ten minutes; `configChanged()` forgets that when the install or Python setting changes, and `release()` stops a seed's worker when its last watch ends. See "Suggesting what to check next" below. |
| `archipelagoSpheres.js`    | Sphere data for a seed, from the extracted multidata table or a spoiler log, and the sphere 1 fallback `!ap next` answers with when the seed's own logic is unavailable. |
| `archipelagoClaims.js`     | Which Discord user holds which slot in which watch, persisted to `data/archipelago_claims.json`. Storage and lookup only; whether a line is worth a ping is decided by `archipelagoMonitor.shouldPing`. See "Slot claims" below. |
| `archipelagoCatchup.js`    | Which lines each watch has already posted, per watch and seed, persisted to `data/archipelago_catchup.json`, plus the pure `buildCatchup` that diffs a tracker read against that record and renders the missed lines exactly as the live relay would. See "Catching up after downtime" below. |
| `jsonStore.js`             | One small JSON file holding one collection: env-overridable path, test gate, lazy cache, atomic write, and a corrupt file moved aside to `<file>.corrupt-<timestamp>` rather than overwritten. The claims, goals, roles and catch-up stores are built on it, and so are the audiobook catalog and bookmarks. Two opt-in options: `feature` names the feature in its log lines (default `'Archipelago'`, so the five Archipelago stores log byte for byte as before), and `durable` fsyncs each write before the rename, keeps an hourly `<file>.bak`, and loads from that backup when the main file is damaged. Only the bookmark store sets `durable`. |
| `logPrune.js`              | Day-file housekeeping shared by every day-file writer under `data/logs/` (bot log, command log, voice-health log): the `PLEXBOT_LOG_RETENTION_DAYS` parse, the hourly throttle and the cutoff. No dependencies, so `logger.js` can use it. |
| `leaderboard.js`           | One ranked-list renderer. Only the Archipelago leaderboard calls in so far; the four game commands still carry their own copies and disagree on the fourth-place marker. |
| `archipelagoGoals.js`      | Lifetime count of multiworlds each user has goaled, keyed `<seed>::<slot>` so it outlives the watch that saw it and so a slot changing hands cannot re-credit a finished game. Recording is idempotent, because the goal set is rebuilt on every reconnect. Goals only, never releases. Migrates the original user-keyed file shape on read. |
| `archipelagoRoles.js`      | Creates and assigns the participant role and the per-count "N Games Goaled" roles, and deletes count roles nobody holds. Records every role id it creates in `data/archipelago_roles.json` and only ever touches those. Degrades to doing nothing rather than throwing. |
| `aiGameRecommender.js`     | "Pick a game" AI helper. Uses centralized `getModel()`. Powers `!pickgame`.                                                            |
| `aiCharacterMapper.js`     | Maps gaming/media habits to a D&D class. Uses centralized `getModel()`. Powers `!buildcharacter`.                                      |
| `characterStorage.js`      | Persists character sheets to `data/characters.json`. Used by `!buildcharacter` and `!mysheet`.                                          |
| `compendiumProvider.js`    | Loads `compendium/FightClub5e.xml` on first access; exposes class/spell/item lookups for the D&D commands.                              |
| `voiceClaims.js`           | Which feature holds a guild's voice apart from the music queue: a Hitster game or an audiobook. Each registers a predicate over its own live state (`register(owner, guildId => label \| null)`), so there is no flag to forget to release; `holder(guildId, { ignore })` asks. A predicate that throws counts as free. Same pattern as `channelClaims.js`. |
| `bookModel.js`             | The arithmetic of a book, pure: where an absolute millisecond falls among a work's parts, its chapters, where a bookmark lands after a rebuild (`resolveBookmark`), how the end of a part's stream is read (`classifyPartEnd`), where `/book play` starts (`resumeStart`), the resume rewind, and the speed, sleep and `goto` inputs. Uses the sum of the part durations, never the work's stored `totalMs`. |
| `bookCatalog.js`           | Turns a Plex music listing into the long-form catalog, pure: which tracks are parts of a book or podcast, which work each belongs to, in what order they play, the overrides, the alias match after a rebuild, and the membership index. Works are built from folders on disk first and Plex albums second. `RULES_VERSION` goes up whenever a rule change would build a different catalog from the same listing. |
| `bookCatalogStore.js`      | The current catalog in memory and in `data/book_catalog.json`, plus the read of `data/book_overrides.json`. Lazy (nothing at require time), atomic `replace()`, `findWorks(text)`, `partKeyFor(workId, { trackRatingKey, file })` by identity, and the memoised `index()` of track, album, artist and part-id Sets that the music exclusion reads. No Plex. |
| `bookLibrary.js`           | The Plex side of the catalog: full listing and build (single flight), chapter probes, the hourly library signature check, the once-an-hour freshness check from `/book play`, and part-key repair through the track's own ratingKey. Never `/search`. |
| `longForm.js`              | Keeps catalogued books and podcasts out of music. `enabled()`, `isLongFormTrack/Album/Artist/Entry`, `partition(list)` into `{ music, books }`, the Plex-side exclusion fragment (`plexExclusion()`, `withExclusion(url)`), and the "📚 Also in your books" redirect lines. |
| `bookmarks.js`             | Each listener's place in each work, in `data/book_bookmarks.json` (durable store, hourly `.bak`), and the stats and leaderboard derived from it. `record()` writes only when the place or the listening time moved by a second or more; a failed write keeps memory, flips `healthy()` and records `book-save-failed` once per failure streak. |
| `bookAudio.js`             | The ffmpeg arguments for a book part (input `-ss` before `-i`, reconnect flags, `atempo` off 1x, Ogg Opus out) and the environment with every proxy variable removed. Pure. |
| `partProxy.js`             | Loopback HTTP proxy between ffmpeg and Plex, so the Plex token never appears on a command line. `127.0.0.1`, random port, a 128-bit path secret per boot, GET and HEAD of `/library/parts/...` only, Host header checked. `probe(partKey)` checks a key with a one-byte range request. Started lazily on the first book play. |
| `bookResource.js`          | One part as an `AudioResource`: spawns ffmpeg-static with the cleaned environment, wraps its stdout as `StreamType.OggOpus`, and SIGKILLs it when voice closes the stream. A spawn failure logs, records `book-stream-error`, and ends the stream. |
| `bookEngine.js`            | The audiobook player. `createBookDirector({ client, bot })` returns `bot.books`: one session per guild with its own AudioPlayer and voice join, controls, saves, sleep and chapter timers, the runPlayback gate (`blocksMusic`), the generic-command delegation (`routeGeneric`), the card lifecycle and `shutdown()`. Every dependency is injectable for tests. See "Audiobooks and podcasts". |
| `bookCard.js`              | The public book card as raw embed and component JSON, rendered from the engine's `view()`. Pure, no discord.js, so a renderer fault cannot reach playback. |
| `bookButtons.js`           | The `book:*` button namespace. A control click runs the engine action and answers with `interaction.update`, which acks and edits the card in one call. A stale card (its session id is not the live one) has its buttons stripped. |
| `processPriority.js`       | Sets the bot process to `above_normal` (default) or `normal` priority from `config.processPriority`, and again whenever `/config` changes it. Never throws; a refused raise warns once. |
| `voiceHealth.js`           | The opt-in voice-health sampler behind `!voicehealth`: per-packet send gaps, source underruns, connection and networking changes, event-loop delay, CPU, memory and GC, rolled into one record per active minute in `data/logs/voice-<date>.jsonl`. Every hook returns on its first line while `config.voiceHealthEnabled` is off. |
| `voiceHealthFormat.js`     | Renders a `voiceHealth.snapshot()` as one Discord message inside 2,000 characters, dropping the oldest minutes first. |

---

## Configuration

Three files in `config/`. The two with secrets are **gitignored**; templates are committed as `.example.js`.

| File                   | Tracked? | What it holds                                                              |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `config/config.js`     | yes      | Feature flags + display strings: `commandPrefix`, `listenChannel`, `playlistsDir`, `serverName`, `ownerId`, `launchRoleId`, `playniteEnabled`, `tautulliEnabled` + `tautulliApiKey` + `tautulliUrl`, `language`, `youtube_quality`, the broadcast block (`broadcastChannelId`, `eventServerEnabled`, `eventServerPort`, `eventServerToken`, `broadcastKometa`, `broadcastGameLaunch`), `archipelagoEnabled` + `archipelagoBatchSeconds`, `archipelagoInstallDir` + `archipelagoPython` for `!ap next`, the six audiobook settings and the two voice settings (tables below). |
| `config/keys.js`       | **no**   | `botToken` (Discord) + `geminiApiKey` (Gemini). Copy from `keys.example.js`. |
| `config/plex.js`       | **no**   | Plex `hostname`, `port`, `https`, `token` (the bot's default user), `homeOwnerToken` (optional, only for cross-account playlist features), `managedUser`, `options`. Copy from `plex.example.js`. |

The boot health check validates the critical keys in `config.js` (`commandPrefix`, `language`, `serverName`, `playlistsDir`) and prints a loud warning if any are missing.

**Runtime overrides.** `config/config.js` defines its values as a `defaults` object, then merges
`data/config.overrides.json` (if present) over them on load, applying only keys that already
exist in `defaults`. That overrides file is written by the `/config` wizard (`helpers/configStore.js`).
Because `bot.config` is the *same* object as `require('config/config.js')` and consumers read
`config.X` at call time, the wizard mutating that object takes effect live for most settings; the
JSON file makes the change durable across restarts. A missing/malformed overrides file is ignored.

**Audiobook settings** (`/config` → Audiobooks). All apply live, and every consumer reads them
with a code fallback (15 s saves, 10 minutes idle, 10 s rewind, speed 1), so a missing or
out-of-range value cannot break playback.

| Key | Type | Default | What it does |
| --- | ---- | ------- | ------------ |
| `audiobooksEnabled` | bool | `false` | Turns `/book` on. Off, every subcommand answers "Audiobooks are turned off…", nothing reads the library and the loopback proxy never opens. Read at call time, so turning it on needs no restart. |
| `audiobooksExcludeFromMusic` | bool | `true` | Keeps catalogued books and podcast episodes out of music once a catalog exists. Turning `audiobooksEnabled` off does not let books back into music; only this does. |
| `audiobookSaveSeconds` | int 5–300 | `15` | Bookmark save interval while playing. The most a crash or hard kill can lose. |
| `audiobookDefaultSpeed` | choice `0.75` `0.9` `1` `1.1` `1.25` `1.5` `1.75` `2` | `'1'` | Speed for a listener's first book; after that each listener keeps their last speed. Stored as a string because it is a menu choice. |
| `audiobookIdleLeaveMinutes` | int 1–180 | `10` | How long a paused or abandoned book keeps the voice channel. |
| `audiobookResumeRewindSeconds` | int 0–120 | `10` | Rewind on resume after more than 5 minutes away, three times this after a day. 0 resumes exactly. |

**Voice settings** (`/config` → Voice). Both apply at once through `configStore.onChange`.

| Key | Type | Default | What it does |
| --- | ---- | ------- | ------------ |
| `processPriority` | choice `above_normal` `normal` | `above_normal` | Priority of the bot process. ffmpeg children stay at normal either way. |
| `voiceHealthEnabled` | bool | `false` | The per-minute voice-health log and `!voicehealth`. |

The constants behind the audiobook engine are code, not settings: the 5 s natural-end slack, 1 s
retry, three early ends in 2 minutes before parking, the 20 s Buffering watchdog, the proxy's 15 s
header timeout and 5 s probe timeout, the hourly library check and bookmark backup, the 120 s
"Mark finished" window, the 24 h catalog age, the 120 s card refresh, 1.5 s card-edit coalescing
and the 30 s gate-explanation limit.

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
| `data/archipelago_claims.json`    | `helpers/archipelagoClaims.js`      |
| `data/archipelago_goals.json`     | `helpers/archipelagoGoals.js`       |
| `data/archipelago_roles.json`     | `helpers/archipelagoRoles.js`       |
| `data/archipelago_catchup.json`   | `helpers/archipelagoCatchup.js`     |
| `data/archipelago/datapackage/*.json` | `helpers/archipelagoData.js`    |
| `data/kometa_theater.json`        | `helpers/kometaTheater.js` (personas + the `seen` set, keyed `library::collection`) |
| `data/kometa_theater_queue.json`  | `helpers/kometaTheater.js` (rendered-but-unposted transmissions) |
| `data/kometa_theater_tail.json`   | `helpers/kometaTheater.js` (log byte offset + whether a session was open) |
| `data/book_catalog.json`          | `helpers/bookCatalogStore.js` (the audiobook and podcast catalog built from the Plex music library: works, parts, file names, Plex keys, rejected folders, the chapter cache and the membership index; about 340 KB on a 21-work library; rebuilt from Plex whenever it is missing or damaged) |
| `data/book_bookmarks.json`        | `helpers/bookmarks.js` (each listener's place, speed and listening time per work, keyed `<discordUserId>::<workId>`) |
| `data/book_bookmarks.json.bak`    | `helpers/jsonStore.js` (hourly copy of the bookmarks, written only from a file that decodes; loaded in place of a damaged main file) |
| `data/book_overrides.json`        | **You.** Hand-edited catalog corrections, read only by `helpers/bookCatalogStore.js`. Never written by the bot. Format under "Audiobooks and podcasts". |
| `data/logs/voice-<date>.jsonl`    | `helpers/voiceHealth.js` (only while `voiceHealthEnabled` is on) |

All four `book_*` files and the `.bak` are gitignored: the bookmarks are keyed by Discord user
id, and the catalog and overrides describe your library. Each has an env override, which the
tests set to a pid-suffixed temp path before the first require:

| Env var | Default path |
| ------- | ------------ |
| `PLEXBOT_BOOK_CATALOG_FILE` | `data/book_catalog.json` |
| `PLEXBOT_BOOK_BOOKMARKS_FILE` | `data/book_bookmarks.json` (the backup is always `<that>.bak`) |
| `PLEXBOT_BOOK_OVERRIDES_FILE` | `data/book_overrides.json` |

Under the test runner without its env var, each book store is memory-only and the overrides
file is never read, the same rule as every other `jsonStore` store, so the bot tests (`app/bot.js`
now asks the catalog whether a track is a book) never see the real catalog or the real overrides.
Outside the runner the stores write to their real
paths, so an ad-hoc `node -e` check against them should set the env vars first.

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
3. Calls `interaction.deferReply()` immediately (Discord's 3-second acknowledgement window). A command may set `slash.ephemeral: true` to defer privately (`flags: MessageFlags.Ephemeral`), which `/config` uses so the settings panel is only visible to the owner who ran it. `slash.ephemeral` may also be a function of the interaction: `/book` is private for every subcommand except `leaderboard`. A function that throws counts as public. The same value is used for the defer and for the failed-defer fallback.
4. Builds a `query` string from the interaction's options, in the same shape the prefix dispatcher produces (so the existing parser code in each command works).
5. Wraps the interaction in `interactionAdapter.adaptInteraction()` → a Message-shaped facade.

**When the defer fails there is no interaction left to answer with.** Its token is dead, so Discord shows the user a bare "This interaction failed", which reads like the command broke rather than that it never started. `helpers/interactionFallback.js` posts an ordinary channel message instead, and that is the only route left.

A `10062 Unknown interaction` on a *fast* defer means the event reached the bot already expired, not that the bot was slow: one measured case answered in 261 ms against the 3000 ms budget, with the bot idle for the seven minutes before it. A gateway resume replaying a queued interaction is the usual reason, so that case says to run it again. Any other failure reports its own reason instead. Neither message echoes the command arguments, because slash options are private to whoever ran the command and this reply is public.
6. Calls `cmd.process(bot, client, fakeMessage, query)` — same signature the prefix dispatcher uses.

**The adapter contract** (`helpers/interactionAdapter.js`): `message.content` is rebuilt in prefix form (`!name args`) rather than set to the bare argument string, because several commands parse arguments as `content.split(' ').slice(1)` and would otherwise lose the first one. The first call to `message.reply(...)` or `message.channel.send(...)` routes through `interaction.editReply(...)`, which appears in chat as the bot's response to the slash command. Subsequent calls go through the real `interaction.channel.send(...)`. That means commands like `!trivia` (which post a "Loading..." status, then edit it, then post game messages) work unchanged: the initial `channel.send` becomes the slash command's primary response, then the game's follow-up messages are normal channel posts.

**Coverage:** every command in `commands/` declares a `slash` block. The loader picks up 56 command entries (54 files plus the `playlist.js/` and `book.js/` directories) and logs `Loaded 56 commands (4 aliases)`; the aliases `?`, `plextest`, `archipelago` and `books` are prefix-only, so 56 slash commands register. Subcommand sets include `/playlist`, `/request`, `/hitster`, `/library`, `/list`, `/tags`, `/ap`, `/book`, `/voicehealth` and the game commands. `npm run check:slash` validates the whole set against Discord's rules without booting the bot: 56 commands, 26,163 bytes of registration payload, the largest `/ap` at 2,783 of 4,000 characters, and `/book` at 1,572.

`scripts/validate-slash.js` exports `validate(commands)` so its rules are tested (`test/validateSlash.test.js`). Beyond names, descriptions, option counts and required-before-optional, it checks:

- **Choice values match their option's type.** A STRING option needs string values of 1–100 characters, INTEGER needs integers, NUMBER finite numbers, and every choice name is 1–100 characters. Discord rejects the whole registration payload over one bad choice, and the earlier validator only checked that a value was present, so `/book speed` declared with numeric values on its STRING `rate` option would have passed `check:slash` and taken every `/command` down with it.
- **The 4,000-character budget per command**, which Discord counts across names, descriptions and choices.
- **Choices and autocomplete only on STRING, INTEGER or NUMBER.**

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
  group's menu is on screen at a time. `configStore.groupNames()` and `selectPages(group)` do
  the division. The embed above the menus lists every group at once, and discord.js throws on
  an embed field value over 1,024 characters: a 60-character room URL, host and role name took
  the 23-setting Archipelago field to 1,050 and `/config` threw. `configStore.panelFields()`
  carries a group that outgrows one field on into a `<Group> (continued)` field, breaking
  between settings. `test/configStore.test.js` asserts all three limits with every setting at
  its longest rendering (Archipelago measures 1,337 characters unsplit, 991 + 345 split), runs
  the fields through discord.js's own `EmbedBuilder`, and checks that every setting stays
  reachable. Nothing checks Discord's 6,000-character total per embed, which discord.js leaves
  to the API; the worst case measures 3,473.
- **Change hook.** `configStore.onChange(fn)` fires after a save is written and applied to the
  live config object. The Archipelago monitor subscribes so a new room, channel or filter takes
  effect on the next batch instead of the next boot. `processPriority.js` and `voiceHealth.js`
  subscribe so a change to either Voice setting applies at once. The audiobook settings need no
  subscription: the engine reads them each time it uses them.
- **Groups.** General, Access, Integrations, Broadcasts, Archipelago, Audiobooks and Voice, in
  that order.
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
  `changes` webhooks for the add/remove detail. It also reads the `<Name> Library` section header
  (`parseLibraryHeader`) and the per-collection `N Movies Missing` line (`parseMissing`).
  Correlated by `collectionKey(library, name)`. Two libraries can hold collections of the same
  name, and keying on the name alone made the second library's pass read as the roll call starting
  over. A short grace period before each post lets the webhook arrive.
- **Classification** (`classifyKind(isSeen, hasAdditions)`): unseen **and** gained nothing → garbled
  `buildStaticText` (no Gemini); otherwise it "reports in" — a brand-new collection with items
  introduces itself, an established one just reports (commenting on changes when present).
- **Mood** (`describeCompleteness`): what a collection holds against what its source list wanted
  (the `Processed` count vs the `Missing` count) grades it complete / nearly / patchy / threadbare,
  and that tier goes into the prompt so a full collection sounds smug and a gutted one sounds
  furious. A collection that never built has no held count, so it gets no mood rather than a wrong one.
- **Personas** are per library+collection-name, minted once via a fast model (`config.kometaTheaterModel`
  → `getModel`) and persisted in `data/kometa_theater.json` alongside the `seen` set. The reply's
  JSON is taken with `extractJsonObject`, which scans for the first *balanced* object. A greedy
  `{…}` match spanned into trailing prose and threw once the token budget gave the model room to
  ramble.
  Gemini and Discord failures fall back to templated text; a parse error can't crash the bot.
- **Pacing**: a self-scheduling worker drains one collection every `config.kometaTheaterDelayMs`
  (the deliberate Discord-side slowdown). No cap — bounded by the number of collections processed.
- **Log tailer**: polls the file, handles rotation (`size < offset` → reset), decodes UTF-8 via
  `StringDecoder`, read-only. Its byte offset is persisted to `data/kometa_theater_tail.json` after
  every read, so a restart mid-run **resumes where it stopped**: `postQueue` already survived a
  restart, but the generation queue behind it did not, so seeking to EOF silently dropped every
  collection still to come. A saved position larger than the current file means the log rotated
  while the bot was down → start at byte 0; no saved position at all → seek to EOF as before. The
  file also records whether a session was open, so a resumed run continues the roll call instead of
  re-announcing the opener.

- **Session end**: `run_end` (webhook, or the `Finished … Run` separator) drains the queue and posts
  the sign-off. If Kometa dies without either, a watchdog closes the session after `WATCHDOG_MS` of
  no log movement. Without it `sessionActive` stayed true and swallowed the *next* run's opener.
  Errors are collected by `onError` and appended to the sign-off as a single card, never posted one
  by one: Kometa fires that hook once per config warning too.

**Brittleness (accepted):** depends on Kometa's log wording: `Finished (.+?) Collection`,
`N X Processed M X Added`, `N X Missing`, `<Name> Library`, `Finished … Run`. Each is one isolated
regex that degrades to less detail rather than failing. Kometa 2.4.8 added a `Mapping <Name> Library`
separator that `parseLibraryHeader` must reject, so re-check these after a Kometa upgrade.

---

## Archipelago room monitor

There are two ways to point the bot at a multiworld, and they run side by side.

**From `/config` → Archipelago.** Twenty-five settings live there. Eighteen describe one room: where it is (`archipelagoRoomUrl`, or `archipelagoHost` + `archipelagoPort`), which slot to observe from, its password, which channel the log goes to, the seven category filters, and five display toggles (progression sends only, hiding sends to finished slots, counting fully-checked slots as finished, colour, markers). Four of those toggles also set the starting value for a room added with `!ap watch`. The other seven are shared by every watch: `archipelagoEnabled`, the batch window, the tracker poll interval, the two role settings, and the two that let `!ap next` rebuild a seed's logic (`archipelagoInstallDir`, `archipelagoPython`; see "Suggesting what to check next"). While `archipelagoEnabled` is on, saving any Archipelago setting re-applies the configured room with no restart, and `syncConfigWatch()` below decides whether that costs a reconnect. The tracker poll interval is the exception: a watch reads it once, when its poll starts, so a saved value reaches a running watch only after that watch is restarted (a changed room, slot, password or DeathLink setting), its inference is toggled, or the bot restarts.

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

Reconnect backoff runs 5s, 10s, 20s, 40s, 80s, 160s, then holds at 300s. The **first** failure of
a fresh sequence against a room URL is logged at debug rather than warn: requesting a paused
room's page is what starts it, and the port is not listening for a few seconds afterwards, so
that attempt fails as a matter of course. `client.isWakingRoom()` is the test, and `attempt`
resets on every successful connect, so each two-hourly cycle gets its own quiet attempt instead
of the allowance being spent once at boot. The second attempt onwards warns, and a `host:port`
target has no wake-up step so it warns the first time. A `ConnectionRefused` (bad slot name, bad password) is treated as fatal instead: the watch is marked paused and says so in the channel, because retrying cannot fix it.

**Only the first connect is announced in the channel.** A hosted room sleeps on its own and returns on the next connect, so drops and reconnects are routine rather than incidents; posting each one turned the channel into a status feed with the log buried inside it. Drops and retries go to the bot log at WARN, and `!ap list` and `!diag` report the live state on request. `connectionNotice()` is the whole decision, kept pure and tested. A deliberate restart (a changed room, `!ap retry`) builds a fresh state and so does announce again, which is the confirmation worth having after changing something.

### Batching and safety

Lines are collected for `archipelagoBatchSeconds` (default 5) and posted as fenced blocks of up to 1,900 characters each, about 20 lines. A busy multiworld emits dozens of item sends a minute, and one message per line would hit Discord's per-channel rate limit and bury everything else in the channel.

**Every post for a watch runs on one serial pipeline.** `pipelines` in `archipelagoMonitor.js` holds a promise chain per watch id, and each flush, catch-up, connection notice, refusal notice and hint-ping run is one task on it, so a multi-message burst always lands contiguously. Two bugs forced this. Two flushes interleaved once one of them took longer than the batch window: the second burst's block landed between the first burst's blocks. And `restartWatch` builds a new state, so the old and new states each had a chain, and a flush still sending on the old one ran alongside the new one's catch-up and both posted the same lines. The pipeline, and the buffer with it, is keyed by watch id and outlives the state: a restart's new tasks queue behind the old ones, and chat and joins waiting to post survive it. Only `removeWatch`, switching the monitor off and clearing the `/config` room drop a pipeline. Every task compares its pipeline with the map before each send, so a flood already under way stops at its next message. A hint-ping task whose state a restart replaced before it ran does nothing: recording the hint then would leave the replacement, whose own hint read replays it, nothing new to announce.

**Nothing is capped.** A flush takes the whole buffer when its task starts, so lines that arrived while an earlier task was sending go out in this one, and posts every chunk; discord.js holds each send until the channel's rate limit allows it. This used to be bounded two more ways: 3 messages per flush with a "…N further block(s) of log trimmed" note, and 500 buffered lines before the oldest were silently dropped. The user asked for every line, and with the catch-up recording exactly what posted, a trimmed line would only have come back later out of order. A 1,000-location release now posts as about 50 messages over about a minute.

A chunk Discord refuses does not stop the flush: the chat and joins in later chunks cannot be rebuilt, and the keyed lines in the refused one can, so its keys stay unrecorded and a catch-up is scheduled 30 seconds out. A channel that cannot be fetched at all schedules the same retry. Each attempt that ends with something refused doubles the wait, up to `archipelagoTrackerPollMinutes`, and only an attempt that posts everything, with nothing still owed, resets it: a channel the bot has lost refuses every retry, and at a flat 30 seconds each one downloaded the whole tracker, about 2,880 times a day per watch. A channel that accepts the header and refuses one block, as AutoMod matching an item name would, used to reset the wait on every accepted header and post a fresh one every 30 seconds. A refused block, a refused header or an unreachable channel shows in `!ap list` as `failing since`. Every keyed line that was due and did not post is held as owed on the pipeline, tagged with its seed, until it is recorded. The tracker can take two minutes to show a send and the first retry comes after 30 seconds, so a retry that finds an owed line missing from the tracker schedules another instead of leaving it to the poll; with `archipelagoCatchup` off, an automatic run posts owed lines rather than recording them silently. Refusal counts are tagged with the seed the same way, since another seed of the same game reuses the same location ids. Claim pings go after the chunks and only for lines whose chunk posted, so a ping never arrives ahead of its own line. `lineCount`, shown as `Relayed:` in `!ap list`, counts lines Discord accepted, live and caught up.

Relayed text is untrusted: it comes from whoever is playing. Every post goes out with `allowedMentions: { parse: [] }`, and any ` ``` ` inside a log line is rewritten to `'''` so it cannot close the fence early and let the rest render as markdown.

### Catching up after downtime

The server replays no history: a client that connects gets `RoomInfo`, `Connected` and a welcome, and nothing that happened before. The room log at `/log/<room>` has everything but needs the room owner's session (see "How the log is read"). What is left is the web host's tracker API, `/api/tracker/<id>`, whose `player_items_received` holds every item each slot has ever received as `[item, location, sender, flags]`, and the socket, which re-reads every goal and hint on each connect. `helpers/archipelagoCatchup.js` diffs those against a record of what the channel has already been shown and posts the difference.

**Identity keys.** Each recoverable line has one, computed the same way from a live packet and from the tracker:

| Line | Key | Live source | Rebuilt from |
| ---- | --- | ----------- | ------------ |
| Item send | `i:<sender>:<location>` | `packet.item.player`, `packet.item.location` | `player_items_received` |
| Goal | `g:<slot>` | `packet.slot`, when `packet.team` matches ours | `client.goaled` |
| Hint | `h:<finder>:<location>` | `packet.item.player`, `packet.item.location` | `client.hints` |

Items at location 0 or below are never keyed. `!getitem` records its item at location -1 from the cheater's own slot and admin `/send` at -1 from slot 0, so every cheat by the same sender would share one key.

**A key is recorded when Discord accepted the message carrying it**, or at once when the watch's filters dropped the line, so switching a filter back on never dumps what it hid. The store persists after every chunk that posts, so a crash between a send and its write costs at most one message of duplicates and never a lost line. The record lives per `<watchId>::<seed>` in `data/archipelago_catchup.json`: relay is per channel, and a seed-keyed record would let one channel's posts hide a catch-up a second channel on the same room needs. A live item send or goal whose key is already recorded is dropped, both on arrival and again when its flush starts, which covers a catch-up posting it from the tracker first. Hints are exempt: the server sends a hint again whenever somebody re-asks for it, and live relays each one.

The Sets behind `has()` live in a separate index and never inside the jsonStore object. `load()` hands back the object `persist()` stringifies, and `JSON.stringify` writes a Set as `{}`: the record would keep its `seededAt`, lose every key, and the next catch-up would post the room's whole history. Sorted arrays are written back just before each persist, only for the records that changed, and the file is written without indentation. It is rewritten after every posted chunk, and a full 79-slot room is about 1.1 MB per watch indented and about 220 KB compact; one persist of two such watches went from 15-25 ms to 6-14 ms. One `process.on('exit')` hook writes anything still unsaved, because the SIGINT and SIGTERM handler in `app/utils.js` calls `process.exit(0)` straight away.

**When it runs.** 130 seconds after every connect (`catchupTiming.settleMs`), again every `archipelagoTrackerPollMinutes`, 30 seconds after a refused send (backing off as above), after an in-process restart, and on `!ap catchup`. 130 seconds is the tracker's worst-case lag plus a margin: the room process saves at most once every 60 seconds, and the API memoizes each tracker for another 60. `!getitem` and admin `/send` do not mark the save dirty, so those can lag longer, and they are cheats the catch-up skips anyway. One run per watch at a time. A request made while a run is going joins it only if that run's tracker read started after the request; otherwise one more run follows. The tracker is fetched from the room URL's own origin, outside the serial chain, so a tracker taking its full 30-second timeout does not hold up the live feed. The diff and the posting then run as one task on the pipeline, after `await client.queue` so every frame already received has been relayed, buffered or filtered first. Lines sitting in the buffer are treated as in flight and skipped.

**Inside the settle window** the tracker can still be missing what happened just before the connect. An automatic run due then, a retry or the periodic one, is skipped, since the run at the end of the window follows anyway; a retry that asked to post passes that on to it. `!ap catchup` still runs: it posts what the tracker already shows, leaves the dated header to the settled run (which can find more), and returns `settlingUntil` so the reply says when that run is due.

A run refuses, without fetching, when the watch is a `host:port` (no web host, so no tracker), not connected, has no seed name yet, or has not yet had its status and hint `Get` answered on this connection (`client.roomStateReadAt`). Without that last gate `client.goaled` is still empty after a reconnect and every goal would look missed. An automatic `loading` answer retries every 10 seconds, at most 6 times per connection.

**First sight of a watch and seed posts nothing.** It records every key the tracker and socket hold, regardless of filters, and logs `catch-up baseline recorded (N items, M goals, H hints)`. The baseline also waits for the settle delay after connecting, so the lagging tracker snapshot covers everything from before the connection; a baseline read earlier would miss those lines and the next run would post them as missed. A baseline that cannot be written is not treated as one, and nothing posts until it can be. A line still waiting in the live buffer when the baseline runs is left out of it, so its flush posts and records it; recorded by the baseline, the flush would have dropped it as already posted.

**The gap snapshot.** On every connect, before anything of that connection posts, the monitor copies the record's `lastPostedAt` and its snapshot of finished slots into `state.gapSince` and `state.gapFinished`. A live flush a few seconds after connecting moves `lastPostedAt` to now, and the header would otherwise say the room was missed since a moment ago on nearly every restart of an active room. The finished snapshot decides `skipgoaled` for recovered items: a slot that goaled during the gap still gets its pre-goal items, as live would have posted them, which errs towards a few extra lines after a mid-gap auto-collect. The record's finished set only grows, since a goal, a release and a full check cannot be undone. It is added to on every posted chunk, on goal and release lines, on filtered lines, on each status read and after each tracker poll while the socket is connected, all without a write of their own, so a slot that finished while nothing posted still counts as finished before the next gap.

**Rendering.** Items are rebuilt as the exact `ItemSend` packet the server would have sent and rendered by `renderPrintJSON` with the client's own colour and marker settings, so a recovered line matches a live one character for character apart from its `[missed]` prefix. Goals use the server's sentence with the display alias. Hints are limited to what the live feed would have received, those where the watched slot is the finder or the receiver or a member of the receiving item-link group, and show their current status. An item-link item appears under every group member in the tracker and renders once, addressed to the group. Order is approximate: each receiver's list is append-only, so items are merged topologically across receivers, with ties broken by same sender as the previous line, then sender activity time, then slot and location. Goals follow, then hints.

The posts go out as a `📜` header outside the fence, naming the watch, the count and the time of the last post before the gap (or when tracking began, if nothing had posted yet), then the lines in the watch's usual fence. A later run in the same connection says `the live feed missed` instead of giving a time. A header Discord refuses stops the run with nothing recorded, so lines never post without it. A line refused before goes out in a message of its own on the next attempt, because a refusal aimed at one line takes down the roughly 20 packed with it. A line refused three times (`MAX_REFUSALS`) is recorded as reported, left out of the next run and named in a warning in the bot log, and the command reply counts it as skipped: discord.js has already retried rate limits and server errors by then, so the refusal is about the content and would repeat forever. Claimants get one summary ping per slot, counted over the lines that posted, and the live ping state is not touched. A run a restart cuts short still sends the summary for the chunks it posted, since the replacement's run skips those committed lines; if the restart lands between the header and the first chunk, that header stands alone and the replacement posts its own.

**Not recoverable:** chat, joins, parts and tag changes, DeathLink, countdowns, the Release and Collect notices (their item sends are recovered and read as ordinary sends), the "Team #N has completed all of their games!" notice, cheated items, start inventory (held only in server memory), hints for items already found, and a bare `!hint` replay.

**`archipelagoCatchup: false`** in `config/config.js` makes automatic runs record what they find without posting it, so switching it back on never dumps an old backlog. `!ap catchup` posts either way. So does the retry after a refused post, live or caught up, since those lines were already being posted and recording them silently lost them for good; and so does the next run after a restart cut a `!ap catchup` short. It stays out of the `/config` wizard because the Archipelago embed field is already about 936 of Discord's 1,024 characters.

Covered by `test/archipelagoCatchup.test.js` (the store and `buildCatchup`), three files that run the live relay and the catch-up together against the stand-in server with the room page and tracker stubbed (`archipelagoCatchupRelay.test.js` for the baseline, gaps, the settle window and filters; `archipelagoCatchupFlood.test.js` for floods, ordering and restarts; `archipelagoCatchupRefusals.test.js` for refused posts, pings and the off switch, sharing `test/helpers/catchupRelay.js`) and the reply paths in `test/archipelagoCommand.test.js`. They lower `relayTiming.minFlushMs` and use a 250 ms batch window. Not covered by a test: the periodic poll, the six-retry cap on `loading`, the in-process restart path, the real `process.exit` path, the `await client.queue` before the diff (no test has a frame still queued in the client when the diff starts), the arrival dedupe on its own (the dedupe at flush start catches the same lines, so only removing both fails a test), and the finished-snapshot refresh on a status read, after a tracker poll and on a filtered Release line.

### What the server says to us, rather than about the room

Two kinds of packet are addressed to this connection rather than reporting room activity, and
both were reaching the channel. `client.isSelfDirected(packet)` recognises them and `shouldRelay`
drops them unconditionally, ahead of the category filters.

**The bot's own join.** The room announces every client that attaches to a slot, the watched one
included, so each reconnect produced `ZackWord (Team #1) tracking Wordipelago has joined.
Client(0.6.1), ['Tracker'].` The real player shares the slot but not the tag list, so tags are
what separate the two: a `Join`/`Part`/`TagsChanged` for our numeric slot whose tags cover ours
and include `Tracker` is us. A player's own join and part still come through under the `joins`
filter, which is what makes a slot going quiet visible.

**The connect welcome.** `Tutorial` ("Now that you are connected, you can use !help ...") is sent
to a client the instant it connects, to that client alone. Relaying it republished the bot's own
welcome text on every reconnect. A hosted room is cycled roughly every two hours, so it arrived
on that cadence: the observed connects ran 01:00, 03:01, 05:01, 07:01 and on through the day.

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

### Item colour and markers

Item class is signalled two ways, because one of them only works on some clients.

**Colour** (`archipelagoColorLines`, default on): batches post as ```` ```ansi ```` blocks and each item name is wrapped by its own `NetworkItem.flags`: **progression magenta, useful blue, trap red, filler cyan**. That mapping is Archipelago's own, so a colour means the same thing here as in the game's text client. **Discord renders ANSI code blocks on desktop and web only**; the mobile apps show the same block as plain uncoloured text, which is how the gap was found.

**Markers** (`archipelagoItemMarkers`, default on): a coloured square prefixed to the item name, 🟪 progression, 🟦 useful, 🟥 trap. Plain text, so every client shows it, mobile included. Filler is deliberately unmarked: most sends are filler and marking them all would be noise rather than signal.

The two are independent toggles and both are on by default, so a desktop reader gets colour and a phone reader gets the marker off the same message. The marker sits inside the colour span, so on desktop it is coloured too.

Class is decided per JSONMessagePart rather than from the packet's headline item, so a line mentioning two items marks each one correctly. A trap that is also flagged progression renders as a trap, on the grounds that the warning is the more useful signal.

`client.colorize` and `client.markers` are both read at render time, so either toggle applies to the next batch instead of costing a reconnect. A plain fence is used when colour is off, because a ```` ``` ```` block would show the escape codes as literal text.

### Finished slots, and skipping items sent to them

Late in an async, much of the remaining item traffic is addressed to players who are already done. `archipelagoSkipGoaled` (default on) drops those `ItemSend` lines. **Done means goaled or released**: releasing hands out everything the slot was still holding, so it is as finished as a goal even when the player never completed. Only items are suppressed; a goal, a hint or a chat line involving that slot still comes through.

The two halves are tracked differently, because the server stores one and only announces the other.

**Goals** are read back from data storage on every `Connected`, since a watch outlives its socket and a hosted room restarts often:

- `Get` with a `client_status` key per slot, and `SetNotify` on the same keys
- `Retrieved` and `SetReply` parsed for `ClientStatus.CLIENT_GOAL` (30)
- a `PrintJSON` of type `Goal` also marks the slot

**Releases** have no readable key anywhere, so that set is built purely from `PrintJSON` type `Release` and deliberately survives a reconnect, since it cannot be rebuilt. A release announced before the bot first connected is invisible to it; a goal is not.

**Fully-checked slots** come from the room's tracker page (`helpers/archipelagoTracker.js`), because the protocol exposes no other slot's locations at all. Gated on `archipelagoInferFinished`, room-URL watches only, polled every `archipelagoTrackerPollMinutes` (default 15). Measured against a live 29-player room: 15 slots were at 100%, and **9 of those had never goaled**, so this is where most of the filtering comes from late in an async.

The tracker's JSON API at `/api/tracker/<id>` looks like the right source and is not: it returns `player_checks_done` as raw location ids with no per-slot total to compare against, since the host computes the total from the seed. The HTML table carries both, as a `124/124` column, so that is what gets parsed. Columns are located by header text rather than position, the parse returns nothing rather than throwing on unexpected markup, and a failed read leaves the filter falling back to goals and releases.

**The caveat:** a player can have every location checked and still be waiting on an item to actually goal. Items sent to them do still matter in that window, and this filter hides them. `archipelagoInferFinished` is the switch for anyone who would rather see those.

The status key is requested under both `_read_client_status_{team}_{slot}` and `client_status_{team}_{slot}`, because the protocol docs give the read-only prefix for the sibling keys but not consistently for this one. Against archipelago.gg the prefixed form answers and the bare form returns null.

**That null is a trap worth knowing about.** Both spellings arrive in one `Retrieved`, so every slot answers once with a status and once with null. Reading the null as "not goaled" deleted the status parsed one key earlier, which left the goal set empty and disabled the whole filter with no error anywhere. `_absorbStatuses` now skips null and undefined, and `test/archipelago.test.js` pins that exact response shape.

### Store durability

Claims, goals and roles go through `helpers/jsonStore.js`, which owns the rules below so they cannot drift apart. Each had its own copy of the same forty lines, differing only in the filename, the wrapper key and whether the empty value was an array or an object.

The feature owns a **fourth** file, `data/archipelago_watches.json`, which does not. Its `{nextId, watches}` envelope does not fit `createStore`'s single-key shape, so `archipelagoMonitor.js` implements the same two rules directly rather than changing the on-disk format. It went without them for longer than the others, and it is the file that holds a room password: a kill during the old bare `writeFileSync` truncated it, the next boot read zero watches, and the first `persist()` after that wrote the empty store straight over it, taking every saved room and its password with it.

They are written through a `.tmp` sibling and renamed over the target, so a kill between the truncate and the write cannot leave a half-file. A file that cannot be used is **moved aside** to `<file>.corrupt-<timestamp>` and the store starts empty but fully writable. That covers both an unparseable file and one that parses into the wrong shape, and the raw value is shape-checked before any `migrate` hook sees it, because a hook that normalises as it goes turns a bad value into a valid-looking empty one.

**This rule has been wrong twice, in opposite directions, and both were worse than quarantine.** Overwriting the damaged file turned one interrupted write into permanent loss. Freezing the store read-only instead was worse still: writes were accepted and reported as successful while never reaching disk, so a run's goals were announced and role-synced against a tally that did not exist, and `sweepCounts` then deleted the count roles the real tally would have kept. Quarantine gives both halves, and `archipelagoRoles.sweepCounts` additionally refuses to sweep when the tally reads empty while count roles exist, since the tally only ever grows.

If the quarantine rename itself fails — a held handle, EPERM from a backup agent — the store sets `blocked` and `persist()` refuses from then on. Without that, the next write destroyed the damaged file one line after the log said `Refusing to overwrite ...; fix it by hand`. Callers are told: `goals.record`/`recordAll` roll their entry back out of the cache and report nothing recorded, and `claims.claim` restores the previous holder and throws, because a claim confirmed with `✅ You are now on ...` that never reached disk works until the next restart and then stops with nothing to point at.

The goal and role stores are built on null-prototype objects, since their keys come from server data and a file edited by hand could otherwise reach `Object.prototype` through one. The old shape (parse-fail, reset the cache to empty, then overwrite on the next write) turned one interrupted write into a permanently lost tally, which is the one thing here that cannot be re-derived from any server. `helpers/tagSidecar.js:118` had the pattern already.

### Slot claims

A claim ties one Discord user to one slot in one watch, so the relay can notify the person who plays that slot. The watch id is part of the key because a slot name only means anything inside its own multiworld. The reverse is left open: on the 29-slot room this was built against, one player held 8 slots, so a user may claim as many as they like.

`!ap claim` is the only mutating subcommand that is not owner-gated. Claiming for yourself is open to anyone; naming someone else still requires the owner. The alternative was the owner hand-registering every player in a large async.

**Claims key on `NetworkPlayer.name`, not on the display name.** `client.players` holds `alias || name` for rendering, and an alias can be changed mid-game. Matching claims against that map would unclaim anyone who set one, silently. `client.slotNames` carries the seed name alongside it, and `canonicalSlotName()` resolves user input against that map case-insensitively so `zackword` stores and reads back as `ZackWord`.

`shouldPing` runs after `shouldRelay`, so every filter above it applies for free: a line dropped by `progression`, `skipgoaled` or a category toggle cannot ping. Ping modes are `all`, `progression` (default) and `off`, held per claim rather than per watch. Only the `items` group pings. A `Hint` packet also names a receiving slot and would be nearly free to add, left out here so it can have its own toggle.

**The ping is a separate message, posted after the log block.** A mention inside a code fence renders as literal text and notifies nobody, and the relay puts everything in a fence. That message is the one place in the monitor that sends with anything other than `allowedMentions: { parse: [] }`; it passes an explicit `users` whitelist of exactly the claimants named in it, so a player who names themselves `@everyone` still cannot reach anyone. The quoted line has its ANSI stripped, since colour outside a fence shows as escape text, and its markdown escaped.

Claims are dropped when their watch is unwatched. Watch ids come from a counter that can reach a used number again, and a stale claim would otherwise attach itself to whatever room next took that id.

Covered by 13 checks across `test/archipelagoClaims.test.js` (storage, casing, ping policy, the alias distinction) and `test/archipelagoPings.test.js`, which drives a real client against a stand-in server and asserts on what reaches the channel.

### The optional watch id

Every id-taking sub-command accepts the id optionally and falls back to the only watch there is. With a single room the number carries no information, and requiring it made `/ap claim` read like it wanted something the user did not have.

That makes the first word ambiguous in the prefix form: `!ap claim 0 ZackWord` gives an id and `!ap claim ZackWord` does not. `argBase` is where the arguments after the id start, and the rest of the parsing indexes off it rather than off fixed positions. With two or more watches the id is required again and the reply says which case it is: no rooms at all reads differently from too many to guess between.

**A leading integer is always the id, including one no watch holds.** Deciding that on whether the id exists reads as friendlier and is the more dangerous half of the trade: a stale id then falls through to the next argument position, which silently retargets the only watch. All three of these were reproduced against the real command layer before the fix. `!ap unwatch 999` deleted the one live room and dropped its claims; `!ap password 7 hunter2` stored the password `"7 hunter2"` after the source message had already been deleted, locking the room out with the real password unrecoverable; and `!ap progression 0 on` read the `0` through `falsy()` and turned the setting **off** while replying that it had. Answering "no watch with ID 7" is recoverable and none of those were. The cost is that a slot literally named `12345` needs `!ap claim <id> 12345`, and `test/archipelagoCommand.test.js` pins both halves.

**A slot name is contained by the code span, not by escaping.** `slotLabel()` wraps the name in backticks and replaces any backtick inside it. Running `escapeMarkdown` first was actively wrong: Discord does no escape processing inside an inline span, so the backslashes it inserts are literal characters on screen, and a slot named `Zack_Word` displayed as `Zack\_Word`. Underscores are everywhere in slot names.

**No reply from this command may ping.** Every send goes through one `say()` helper that sets `allowedMentions: { parse: [] }`, and the connect flow's status edits go through `editQuietly()`, which falls back to a fresh message when `say()` returned null because the first send failed. Both swallow, because handlers `return` them without awaiting and a rejection would otherwise escape the try/catch. Replies quote slot names, player names and server error text, none of which the bot authors: `slotArg` strips user mentions but not role mentions, so `!ap unclaim <@&role>` had the bot echo a live role mention, and the participant role it creates is mentionable. Suppressing at the one helper rather than at the four sites that happened to interpolate user text is what stops the next reply reintroducing it.

In the slash form `id` is declared last on every sub-command. Discord rejects the whole registration payload when a required option follows an optional one, and `scripts/validate-slash.js` fails the build on it.

### Hints

`_read_hints_{team}_{slot}` is readable for every slot, not only the connected one, and until now
nothing read it. It rides the same `Get`/`SetNotify` the status keys use, added to the same
request on connect.

**Each hint arrives twice.** The server files one under the finder and again under the receiver,
so reading all 29 slots on the room this was built against returned 2,031 entries for 1,043
hints. `client.hints` keys on `team:finding_player:location`, which is what collapses the pair.

`outstandingHints()` filters on `found`, since an already-collected hint is history. 45 of those
1,043 were outstanding.

Name resolution follows the same split as `PrintJSON`: **the item belongs to the receiver's game
and the location to the finder's.** Getting that backwards mostly resolves to nothing, and
occasionally to a name from the wrong game. One item id in this room's packages exists in five
of them.

`!ap hints [id] [slot]` lists them, priority first (`HintStatus` 30; 0 is unspecified and 40 is
found). The slot filter matches either side, so a claimant sees both what they owe and what they
are waiting on.

### The hint ping, and why it starts off

When somebody hints an item out of your world, **the finder is pinged, not the receiver.** The
receiver placed the hint and already knows; the finder is the one who can act on it.

Per claim, `off` by default, set with `!ap hintpings [id] <slot> <off|dm|channel>`. It is a
separate setting from `pings` rather than a mode of it, because it is a different event and a
much easier one to resent: it is a request for someone's time, it arrives whether or not they are
playing, and one slot can be the target of many at once. `dm` never falls back to the channel,
because choosing it was a choice to keep this out of the channel.

**The first read of a multiworld is seeded silently.** Every connect replays the entire hint list,
and a hosted room forces a reconnect roughly every two hours, so without a record of what has been
seen each cycle would re-announce everything outstanding. Worse, the first read is a backlog
rather than news: on the live room 45 hints were outstanding and **20 of them sat against a single
slot**, so announcing on discovery would have opened with twenty pings for whoever held it.
`archipelagoHints.seedBaseline()` records them all as seen without notifying anyone, and only
hints created after that point are announced.

The seeded marker is explicit rather than inferred from "this seed has no keys yet". A room whose
first hint had not been placed would otherwise seed on that first hint and swallow it.

Keyed `<seed>::<team>:<finder>:<location>`, on the seed for the same reason the goal tally is: a
hint belongs to a multiworld, which outlives the watch id pointing at it. A failed write returns
nothing rather than risk announcing twice, since a ping sent against a record that never persisted
fires again on every connect after it.

Covered by `test/archipelagoHints.test.js` (16 checks on the reading, the baseline and the opt-in)
and `test/archipelagoHintPings.test.js`, which drives a real client against the stand-in server
and asserts a 20-hint backlog pings nobody.

### Goal tally and roles

**Only a `Goal` counts.** `recordGoals` reads `client.goaled` and nothing else. A release hands out the slot's remaining items without anybody finishing it, and a fully-checked slot can still be waiting on an item to goal. Both make `hasFinished()` true, which is the right answer for the relay filter and the wrong one for a tally of games completed. Reaching for `hasFinished()` here is the mistake this section exists to prevent, and `test/archipelagoGoals.test.js` pins it with a state carrying one goal, one release and one 100%-checked slot.

**The record is keyed by the goal, not by the person:** `{ "<seed>::<slot>": { userId, at } }`. Keying it per user made the idempotence per user too, so a slot changing hands re-credited a game the previous holder had already finished — the new claimant simply had no key for it, and every reconnect replays the whole goal set. `load()` migrates the original user-keyed shape on read, idempotently, so no file needs converting by hand.

**Only the connection's own team is counted.** `client.goaled` carries every team the server reports and slot numbers repeat across them, while a claim has no team at all, so `recordGoals` skips any id whose team is not `client.team`. Both `slotNames` and `players` are keyed `team:slot` to match `goaled`/`released`/`fullyChecked`; keyed by slot number alone, team 1's entry overwrote team 0's, so either team's goal was credited to whoever claimed the surviving name and every relayed line naming that slot rendered the wrong player. `slotsOnTeam()` backs the two places that need a per-team roster: `_statusKeys`, which would otherwise ask for another team's slot numbers under this team's prefix, and the slot count reported on connect.

**A reconnect may be to a different room.** `_handleConnected` clears `players`, `slotNames` and `slotGames` before absorbing, because `_absorbPlayers` only ever sets, and `_handleRoomInfo` assigns `seedName` unconditionally. `restartWatch` takes a `sameRoom` flag and carries nothing identifying the old multiworld when `/config` is re-pointed. Without all three, a re-pointed watch kept the old seed in its goal key, so a slot name present in both rooms was deduped against a goal from the room that no longer exists.

Records key on `<seed_name>::<slot>`. `RoomInfo.seed_name` is stable for the life of a multiworld and unique across them, which is what lets the tally outlive the things around it: a reconnect, a hosted room restarting on a new port, the watch being removed, and the watch id being handed out again. A watch id or a `host:port` would fail all four. When a server sends no seed name the target string is used instead, which is stable for a room URL and not for a hosted room's moving port.

Recording is idempotent because the goal set is rebuilt from `_read_client_status_{team}_{slot}` on every connect, so the same goal is offered many times. `record()` returns true only the first time, which is what drives the role update.

Two triggers, both needed:

- `client.on('statuses')`, emitted by `_absorbStatuses` when the server answers the status `Get`. Goals that happened before the bot connected arrive here. The `connected` status fires too early, when the goal set is still empty.
- A `PrintJSON` of type `Goal`, checked **ahead of `shouldRelay`** so a goal still counts when the goals category is switched off for that channel.

**Roles.** The participant role follows whether the user holds any claim at all, across every watch, because a watch is not guild-scoped and the configured room has no guild id to compare against. The count role is a lifetime tally and is never removed for having dropped, only swapped upwards.

The sweep asks `archipelagoGoals.leaderboard()` which counts are still held rather than asking Discord who holds a role. `role.members` reads the member cache, and the bot runs without the `GuildMembers` intent, so that cache holds only members it happens to have seen. Single-member `guild.members.fetch(id)` is a REST call and works without the intent, which is what member lookups use.

Role creation is serialised per guild and role by a small in-flight guard. `syncRoles` is fire-and-forget, so two goals landing in the same frame both passed the check-then-create and made a duplicate role that the store never recorded, which meant the sweep could never delete it and it had to be removed by hand. The new count role is also added **before** the stale one is removed: the other order left a member on no count role at all if the add hit a rate limit, and nothing retries, because a sync only runs when the tally actually changes.

Every role id the bot creates is recorded per guild in `data/archipelago_roles.json`, and assignment and deletion only ever touch ids in that file. Name matching would let the bot delete a hand-made role that happened to fit the pattern. A recorded role that has been deleted in Discord, or dragged above the bot in the hierarchy, is treated as absent and replaced rather than retried forever.

### Suggesting what to check next

`!ap next [id] [slot]` answers with the unchecked locations a slot can reach **in logic right
now**: the seed's own access rules, evaluated against the items that slot has received. The rules
live in each game's Python world, so the answer comes from a Python process loaded from the
Archipelago install that generated the seed (`scripts/ap-logic-worker.py`, managed by
`helpers/archipelagoLogic.js`). When that cannot be had, the answer is the slot's sphere 1, and the
reply says why. A sphere is a generation-time idea: sphere 1 is reachable with nothing, sphere 2
needs sphere 1's items, and so on.

**Only for slots the caller has claimed**, the bot owner included. A suggestion is a nudge about
what is in somebody's world, so it goes to the person playing it and to nobody else.

**Naming a slot is optional, and leaving it out answers for every slot the caller holds.** Asking
per slot was the first shape and it was the wrong default: somebody playing four games had to
remember and type four slot names to be told the same four things, and the answer they wanted was
always the union. A named slot still narrows it, and a slot the caller has not claimed is refused
whether or not they hold others.

The read behind an answer is split in two for that reason. `prepareSuggest(id, { onWait,
slotNames })` does the I/O once per command: resolving the room page to a tracker id, getting a
ready logic worker for the seed (or, when there is none, loading sphere data), and one tracker read
for every slot's checks and received items. `answerAll(prep, names)` then asks the worker about
every slot in a single `inLogic` request, or, with no worker, runs `suggestFor(prep, slot)` per
slot, which is arithmetic with no I/O at all. Answering eight claimed slots through a single-slot
path would have re-fetched the tracker's 400 KB of check data eight times to answer one command.

A reply holding several slots gives each a summary line and three names, and stops at a
1,900-character budget, counting off any slots it could not fit rather than being cut in half by
Discord at 2,000. A reply about one slot, named or the only live one the caller holds, lists up to
fifteen. A list one name over the cap shows that name rather than `…1 more`.

**From the logic, a block lists only the soonest sphere with anything in logic, and counts the
rest.** `answerFromLogic` sorts the slot's in-logic locations by sphere and then name, returns that
sphere's names as `locations` and its number as `sphere`, and counts each later sphere into
`later` as `{ sphere, count }`, in sphere order. `total` is everything in logic and `open` every
unchecked location. This replaced one list run across every sphere, which showed the first few
names in logic and never said which sphere they came from, and the heading per sphere that a
one-slot reply briefly carried inside its fifteen lines.

The summary line after the slot name, with counts in thousands separators:

- **Several slots:** `sphere 1: 56 in logic · +1,177 later · 1,696 locked`, then the names and
  `…N more`.
- **One slot:** `sphere 1: 56 in logic`, then the names, `…N more in sphere 1`, and an italic
  closing line, `Also in logic: sphere 2 (1,175), sphere 3 (2) · 1,696 still locked`. With nothing
  later it reads `Nothing later in logic yet · 3,825 still locked`, and with nothing later and
  nothing locked it is left out. With nothing in logic at all the block is
  `nothing in logic yet; 73 still locked.`
- **The sphere 1 fallback:** `sphere 1 only: 12 open · 40 further in`, and `…N more in sphere 1`
  for one slot. An answer from a spoiler has no "further in" (see "The sphere 1 fallback").

"Locked" and "further in" are the rest of the slot's unchecked locations, `open` less `total`.
Locations in an unreachable remainder (see "The self-check") carry no sphere and read as
`no sphere`, counted after every numbered sphere.

**A slot with nothing to list gets no block in a reply about several slots.** A slot with nothing
in logic, a fallback slot with nothing open in sphere 1, and a slot with nothing left to check are
each named in the footer instead, as ``2 with nothing in logic yet: `A`, `B`.``,
`N with nothing open in sphere 1: …` and `N with nothing left to check: …`, at most ten names and
then `and N more`. The header counts only the slots given a block,
`What is in logic across 19 of your slots`, and reads `Nothing in logic yet across your N slots`
when every live slot went to the footer. A slot not in the room, or whose query failed, still gets
its one-line block.

**Slots are listed earliest sphere first** (`orderBySoonest`): slots with locations listed, by
their soonest sphere, then slots with no answer at all. `orderBySoonest` still sorts slots with
nothing listed between the two, which a several-slot reply no longer holds. Ties go by slot name,
ignoring case, so the same room always lists the same way. Claim order said nothing about where to
go, and it decided which slots the budget cut. Now the first block is the nearest thing to do, and
the budget cuts from the far end. On the room this shipped against, one player held 21 slots: 2
had nothing in logic and went to the footer, and 10 of the other 19 fit.

**Within a slot, the listed names go in natural order**, so `Chest 2` comes before `Chest 10`,
whichever source answered. The worker's own list comes back in location id order within a sphere,
and `answerFromLogic` re-sorts it by sphere and then name. `suggestFor` sorts the table fallback's
names once it has resolved their ids, and `sphereOneFromRows` sorts the spoiler's the same way.

**Finished slots are skipped, and that is settled first** (`resolveSlot`), before any logic, sphere
or tracker work. A goaled slot can still have locations open, and the logic would list them. A
finished slot never goes into the worker's request, and `suggestFor` resolves the slot before it
looks for sphere data, so a finished slot is never told there is no sphere data. When `slotNames`
holds no slot that resolves (every one finished, or not in this room), `prepareSuggest` returns a
`settled` prep without touching the worker, the sphere files or the tracker, and `answerAll`
answers from `resolveSlot` alone. A player whose slots have all goaled is told so at once, rather
than after a minute-long rebuild that nothing in the reply would use. Finished slots are counted
off in the footer rather than given a block each: anyone deep into a big async has more slots done
than running, and a reply that is mostly "nothing left to check" buries the ones they can act on.
Naming a finished slot explicitly still answers about that slot.

**How a slot finished is often unknowable, and the reply does not guess.** Goal status is read back
from data storage at every connect, so it survives a restart. A release is not: it arrives once as
a live `PrintJSON`, there is no key to re-read it from, and `client.released` starts empty on every
boot. A slot released while the bot was down is therefore indistinguishable from one that goaled
without its client ever reporting it; both are simply at 100% checked. That third state is carried
as `how: 'complete'` and rendered as "finished".

This is not hypothetical. On the room this was built against, six slots were done: three carried
`client_status` 30 and three carried 0 while sitting at 100% checked, and all three of the latter
were releases. Calling 100%-checked "goaled" would have been wrong every time it mattered.

The relay filter is unaffected by any of this. A release checks every remaining location, so
`inferFinished` already catches released slots through the tracker's 100% column.

**The item at a location is never read for an answer, and never shown.** Locations are ordered by
sphere and name and nothing else, and no location is preferred over another for what it holds. The
reply says where to go, never what is there, because the second sentence is the spoiler. The
worker's input is the items a slot has *received*, which that player already knows. The one place
placements are read is the self-check below, which replays what each sphere handed out, and nothing
from it reaches a reply beyond whether the slot passed.

#### Why spheres cannot say what is in logic

`!ap next` used to answer from sphere numbers alone. **If a location in sphere N had been checked,
every unchecked location of that slot in spheres up to N was offered**, on the reading that sphere
N had been reachable and spheres are ordered by what they require. That reading is unsound. A
sphere is what became reachable once every item from the spheres before it had been collected,
across the whole multiworld, so a slot's sphere 3 location can hang on an item still sitting in an
idle player's sphere 1, and a different sphere 3 check proves nothing about it. Measured on the
live 79-slot room: the rule listed 13,155 locations, and 11,409 of them could not be proven in
logic. The seed's own rules list 6,174 for the same room, and a rule that stays sound on spheres
alone would list 1,778. The rule is gone, and `soonestInLogic`, `soonestFromTable` and `reachOver`
with it.

**The web sphere tracker cannot help either, which was measured rather than assumed.**
`/sphere_tracker/<id>` is linked from every room page and looks like exactly the right source. It
lists only locations that have **already been checked**. Every slot's row count on the room this
was built against equalled its checked count exactly, and so did the totals, 13,768 against 13,768.
DaveSMetroid had 87 rows for 87 checks with its 13 unchecked locations absent entirely. It is a
record of what has been found, sphere by sphere, so asking it what to do next can only ever answer
"nothing". The code does not use it, and this paragraph is here so nobody re-derives that.

#### The logic worker (`scripts/ap-logic-worker.py`)

It imports the Archipelago install as a library, rebuilds the seed's multiworld with every rule in
place and nothing filled, checks that rebuild against the seed's multidata, and then answers
queries until stdin closes. Its module docstring holds the protocol.

**The install is a cx_Freeze build, and the worker loads it the way `ArchipelagoGenerate.exe`
does.** Its compiled modules load into the Python minor version it was frozen with and no other,
3.13 for Archipelago 0.6.7. The worker reads that version off the `python3XX.dll` shipped beside
it and stops at once on any other. `bootstrap()` repeats the parts of cx_Freeze's own startup that
matter: an import finder for the extension modules cx_Freeze keeps flat in `lib/` (as
`lib/bsdiff4.core.cp313-win_amd64.pyd`), without which every world that imports one fails to load;
`sys.frozen` and `SKIP_REQUIREMENTS_UPDATE`, since `ModuleUpdate` otherwise pip-installs whatever it
thinks is missing into this Python at import; and `argv[0]` pointed at `ArchipelagoGenerate.exe`,
since a frozen process's `Utils.local_path` is the folder of `argv[0]`. The interpreter runs with
`-O -s -S -B`: `-O` because the frozen build was compiled with `optimize=1`, and an assert that
fires here but was stripped there would make the rebuild differ; `-s -S` so nothing installed into
this Python can shadow what `library.zip` ships; `-B` so nothing is compiled into the install's
folders.

**Nothing is written into the install.** An audit hook refuses any file opened for writing, and any
rename, removal, link, permission or timestamp change or new folder, under the install's path. A
rename, replace or move is checked at both ends, so moving a file out of the install is refused as
well as moving one in. `host.yaml`'s save-on-exit, the file dialog a world opens when it wants a
ROM (which would wait for a click nobody makes), and pip auto-updates are all switched off before
generation runs. Generation's own output goes to a temporary folder.

**The seed number comes from the spoiler inside the output zip, with the Generate log as a
spare.** A rebuild needs the Players yamls, the apworlds and the seed number. The multidata has
only the seed name, which is derived from the number. Archipelago writes the number in two places:
the first line of the spoiler it packs into `output/AP_<seed name>.zip`
(`Archipelago Version 0.6.7  -  Seed: <number>`), and `<install>/logs/Generate_*.txt`, on a line
like `Generating for 79 players, <seed name> Seed <number> with plando: ...`. **Archipelago deletes
its logs after a week**, and the first version read only the log, so every seed stopped being
rebuildable seven days after it was generated. The worker now reads the spoiler first
(`seed_from_spoiler`) and uses `--seed` only for a seed generated without one. With neither, it
stops, and the seed gets sphere 1 only.

`--seed` comes from `findSeedNumber` on the Node side, which reads the first 128 KB of each log,
newest first, and matches on the seed name, because a run that failed and was retried leaves a log
per attempt under a different seed. A seed that is not found is only searched for again once the
logs folder's modification time moves. A miss is not a failure: the worker is started without
`--seed`.

**Generation runs unchanged up to the fill, and stops there.** `Generate.main` re-rolls the yamls
with the real seed number before anything imports worlds: options are rolled from the global
`random` right after it is seeded, and a world that draws from it at import has to draw at the same
point it did in the real run. A re-roll that names a different seed means the number belongs to
some other seed, and the worker stops.

**The Players folder is then compared with the multidata, slot by slot, before anything is
built.** The seed name comes from the number alone, so the check above cannot notice a Players
folder that has moved on to the next async. Players are numbered in file name order, so one yaml
added or removed renumbers every slot after it. Every rolled slot's name and game has to match the
multidata's `slot_info` (item-link groups left out), and a mismatch stops the worker with how many
slots differ and the first of them, which the bot log records. The whole seed then gets sphere 1
only. The check runs before the half-minute build, so a stale folder fails fast.

`Main.main` then runs as it is, with `distribute_items_restrictive` and `flood_items` swapped for a
function that raises with the multiworld in hand. Everything that decides logic (options, regions, rules, entrances, events,
locked items) is settled by then; the fill only places items, and it is where the nine minutes of a
full run go. `--skip_output` matters only for what it skips before that point, the
`assert_generate` stage, where worlds go looking for ROMs. Worlds' `stage_post_fill` hooks are run
afterwards, because some set logic state there from the item pool and the rules alone (Super
Metroid's `onlyBossLeft`, which every `CollectionState` copies). One that needs placements fails
and is skipped, and the self-check catches what that costs. A seed generated in race mode is
refused, since it cannot be reproduced.

**Evaluation is Universal Tracker's, strict tier only** (`TrackerCore.updateTracker`). Each query
builds a fresh `CollectionState`, because some worlds keep logic caches on the state and a reused
one would carry one slot's items into the next answer. Received items arrive as
`[item, location, flags]` and are recreated with the classification set from the flags exactly:
generation can end with a classification `create_item` would not give (surplus copies of a counted
item are made useful or filler, and some worlds upgrade classifications after the fill), and
matching it is what reproduces the seed's spheres. **An item nobody found is the exception.**
`/send`, `/send_multiple` and `!getitem` hand one out from location -1 with flags 0, whatever it
is, and forcing those flags would turn a key given out that way into filler that opens nothing. An
item with a location below 0 keeps `create_item`'s own classification, OR'd with the flags. The
flags also pick between two names sharing one id, which Kingdom Two Crowns does with 755177. Start
inventory is not in the tracker's received list, and `CollectionState` collects the multiworld's
precollected items itself. Events are then swept, and the answer is every unchecked location of the
slot that the state can reach.

**Worlds print freely while they import**, so the worker points file descriptor 1 at stderr before
importing anything and keeps a duplicate of the real stdout for the protocol alone: JSON lines,
`progress`, `ready` and `fatal` events, and replies matched to requests by id.

#### The self-check

**Every slot is checked against the multidata before any answer from the rebuild is trusted.** Its
location ids have to match, and then generation's own spheres are replayed through the same
`reachable()` the queries use. Sphere k is exactly what became reachable once every item from the
spheres before it was collected, so for each slot, given the items it received from spheres before
k, `reachable()` has to return precisely that slot's locations in spheres 1 to k. Anything missing
means the rebuild is stricter than the real seed and anything extra means it is looser; either way
that slot is answered with sphere 1 only. Because the replay runs the query path itself, it also
catches a slot whose rules read another slot's items, which a query collecting only the asking
slot's items would get wrong. Items received by an item-link group are credited to every member.
An exception during a slot's replay fails that slot's check with the error as its reason.

**The last sphere in the multidata may not be a sphere.** When generation leaves locations
unreachable it yields an empty sphere and then all of them, and `Main.py` drops the empty one, so
the multidata's last entry is either a real sphere or that unreachable remainder, with nothing in
the file to tell them apart. The rebuild tells them apart: with every earlier item, the remainder's
locations are reachable or they are not. That is one fact about the whole multiworld, so every slot
with locations in that entry votes on it. **When the votes disagree, every slot that voted either
way falls back to sphere 1**, whichever side had more votes: two readings of one fact cannot both
be right, and nothing says which is. `lastSphereUnreachable` in the `ready` event is then `null`, rather than
`true` or `false`. A slot with no locations in the last entry has no vote and keeps its verdict.
When the slots agree it is unreachable, its locations carry no sphere number in an answer and sort
after every numbered one.

The worker then announces `ready` with a verdict per slot, and the bot log records how many passed
and names each one that did not, with the reason. Verified live on the 79-slot room: 79 of 79 slots
passed, the worker was ready about 38 s after starting, and one request covering all 79 slots took
303 ms. Those numbers were measured before the spoiler seed number, the Players comparison and the
`/send` classification rule were added.

#### The Node side (`helpers/archipelagoLogic.js`)

`locateSeed` finds what the worker needs, or says which piece is missing: the install
(`archipelagoInstallDir`, `C:\ProgramData\Archipelago` by default, blank for off), its Python
version from the `python3XX.dll`, and the output zip at `<install>/output/AP_<seed name>.zip`.
**The zip is what says the seed was generated here**, and a missing one is `not-generated-here`. The
seed number is looked up in the Generate logs as a spare and is `null` when no log names it;
`--seed` goes on the worker's command line, after `--multidata`, only when it is known.

Each miss carries a reason code and a `detail`. **The reply shows only a short phrase for the
code** (`LOGIC_UNAVAILABLE` in `commands/archipelago.js`: "this seed was not generated here", "the
Python it needs is not installed", and so on) and never the detail, which holds paths on the host
and the worker's own error text. That covers the footer note on a sphere 1 answer and the lead of
the reply that asks for sphere data. For `failed` the phrase points at the bot log, which has the
detail, and for a start that failed the last five lines of the worker's stderr too. A slot that
failed its self-check reads as `unverified`, "the rebuild did not match this slot".

`resolvePython` uses `archipelagoPython` when it is set, and otherwise asks the Windows launcher
(`py -3.13`) for its `sys.executable`. **The worker runs on that `python.exe` directly, never
through `py`**: the launcher starts Python as a child and waits on it, so killing the launcher
would orphan the half-gigabyte process under it. A launcher that finds nothing is asked again next
time, so installing Python is picked up without a restart.

**One worker, started by the first `!ap next` that needs it, then kept while its seed is
watched.** Loading every world and rebuilding a big seed takes most of a minute and about 0.5 GB,
so it is neither done per command nor at startup for a command that may never run.
`acquire(seedName, { onWait })` starts it, and calls `onWait` once before waiting on a worker that
is still starting, which the command uses to edit its status message to say the seed's logic is
loading. Callers that arrive during a startup share it. The worker is keyed
`<install>|<seed name>`, and a different seed, or a different install, replaces the running worker
rather than adding a second, since each holds a whole multiworld. It is stopped:

- **When the last watch on its seed ends**: `!ap unwatch`, or the configured room removed in
  `/config`. The monitor's `releaseLogicFor` calls `release(seedName)`, and leaves the worker alone
  while another watch is on the same multiworld. A watch restart is not an end, since the next
  `!ap next` would pay for the rebuild again.
- **When the configured room is pointed at a different room**, through the same `releaseLogicFor`.
- **When `archipelagoEnabled` is switched off, or `archipelagoInstallDir` is blanked**, as the
  setting is saved. `applyConfig` calls `configChanged()` first on every `archipelago*` save,
  whether or not the monitor is on, and it stops the worker when the install is blank; switching the
  monitor off calls `stopAll()`. Before this, both only stopped new rebuilds and left a running
  worker holding its memory until the bot exited.
- **When a query gets no answer in 60 s.** The worker answers one request at a time, so a stalled
  one holds up every question behind it. The timeout logs, marks the worker as stopping and kills
  it, and the next `!ap next` starts a fresh one.
- **When the bot exits.**

A worker gets five minutes to become ready (38 s measured idle; the same machine has taken four
times as long for a generation with other work running beside it) and 60 s per query. It keeps the
last 40 lines of its stderr, and the last five go into the bot log when it fails. **A spawn that
throws** instead of reporting an `error` event (a `.cmd` given as `archipelagoPython` is one) is
caught in `LogicWorker.start()` and leaves the worker exited, so the start fails at once rather than
leaving every later `!ap next` waiting five minutes on a process that never existed. Anything else
that throws while `acquire()` chooses a worker comes back as `failed`.

**A failed start is remembered for ten minutes** (`FAILURE_RETRY_MS`), under the same
`<install>|<seed name>` key. The cause is on disk and usually stays there, so this stops every
`!ap next` from paying another minute for the same failure. **Saving a different
`archipelagoInstallDir` or `archipelagoPython` forgets every remembered failure** and the cached
Python lookup, so a fix is tried by the next `!ap next` rather than ten minutes later.
`configChanged()` compares against the settings it saw last, and its first call, at boot, only
records them. **A worker stopped on purpose is not remembered as failed** (`worker.stopping`): one
replaced by another seed, or released because its watch went, while it was still starting would
otherwise hold its seed on sphere 1 for ten minutes. A worker that dies or stalls mid-question is
not remembered either; `answerAll` answers that command from sphere 1 (see below), and the next
`!ap next` starts a fresh worker.

#### The sphere 1 fallback

**Sphere 1 is the one sphere every slot can always enter.** Generation found it reachable with
nothing but the starting inventory, so it is in logic at every point in the game. `!ap next`
answers with it whenever exact logic is unavailable, in three cases:

- **For the whole seed**, when there is no worker: `archipelagoInstallDir` is blank or holds no
  install, the room has not named its seed yet, the seed was not generated with that install (no
  output zip), no matching Python is found, or the rebuild failed, which includes a Players folder that no longer matches and a seed number found in neither
  the spoiler nor the logs. `prepareSuggest` then loads sphere data (`ensureSpheres`) and
  `suggestFor` answers each slot from it, through `sphereOneFromTable` for the multidata table and
  `sphereOneFromRows` for a spoiler. The footer carries the reason as its short phrase.
- **For the rest of one command**, when the worker dies or stalls mid-question. That happens after
  `prepareSuggest` has handed over a worker, so it is `answerAll` that catches it: it logs the
  error, loads sphere data itself and answers every slot through `suggestFor`, with the reason
  `failed`.
- **For one slot**, when the worker is running but that slot failed its self-check, including every
  slot that voted in a disagreement over the final sphere, or when evaluating that slot's query
  throws. The worker answers it with its unchecked sphere 1 locations, built from the multidata's
  own location ids for the slot rather than the rebuild's, so a slot the rebuild got wrong is still
  answered about its real world. No sphere files are involved, and the footer gives the phrase
  for `unverified`, "the rebuild did not match this slot". `answerAll` logs a warning for each
  slot whose answer is missing or carries an error.

From the worker or the multidata table, the answer also counts every unchecked location of the
slot (`open`), so a block reads `sphere 1 only: N open · M further in`, or
`nothing open in sphere 1; M further in.` once sphere 1 is done. In a reply about several slots, a
slot with nothing open in sphere 1, from any source, is named in the footer instead.

**An answer from a spoiler carries no count and never says a slot has nothing left.** Its
Playthrough lists only the placements the seed's completion needs, so running out of its rows says
nothing about the slot being done, and the number of rows still unchecked is a count of required
items still out there, which is a hint. `suggestFor` sets `open` to `null` on that path, and a
block reads `sphere 1 only: N open` with no "further in", or
`nothing open in sphere 1 that the spoiler lists.` A slot the spoiler has no rows for at all reads
the same way. The Playthrough also lists events (boss kills, goals), which no tracker ever reports
checked; once the game's data package has loaded it tells the two apart, and until then events are
left in.

With neither logic nor sphere data, the reply leads with the short phrase for why the logic was
unavailable and then says how to get sphere data.

#### Where the spheres come from

Two sources, and they are not close in quality. **Both now serve only the sphere 1 fallback.**
`RoomInfo.seed_name` names the file either way, which is the same identity the goal tally and the
hint store key on.

**The multidata's own sphere table, which is the good one.** Generation already worked this out and
wrote it down: the `.archipelago` multidata carries a top-level `spheres` field, a list of spheres
each mapping player to the location ids reachable in it, covering **every** location rather than
only the progression ones. `scripts/extract-spheres.py` lifts it into
`data/archipelago/spheres/<seed_name>.json`. It is keyed by location id, which is also what the
tracker reports, so the two sides compare directly and the data package is consulted only to name
the handful about to be shown. A slot whose package has not finished downloading still gets a
correct answer.

It needs the multidata, so it is available only for a multiworld generated on this machine
(`<Archipelago>/output/AP_<seed>.zip`). Such a seed normally gets exact logic, so the table is for
one whose logic worker cannot start, such as a machine without Python 3.13 or a Players folder that
has moved on to the next async.

**The seed's spoiler log, which is the last resort**, at `data/archipelago/spoilers/<seed_name>.txt`.
Its Playthrough section lists placements whether or not anyone has reached them, but only the ones
the seed's completion depends on. **Measured: 1,728 rows against 14,783 locations, 11.7%.** For one
slot it was 43 of 529. Under the old reach rule, after checking 42 of those the command reported
"nothing reachable yet" while **41 locations sat open and every one of them in logic**. That is what
motivated the multidata path: the spoiler had run out of things it could see, and said so in a way
that read like a logic wall rather than a data wall. The same slot against the multidata table
answered 41 reachable, 0 beyond.

The preference is not a tie-break. A spoiler left in place beside an extracted table is ignored.
A table that parses but holds no slots falls through to the spoiler rather than being trusted,
because a slotless table answers "nothing left" for every slot in the room, which reads as
everybody being finished.

**The files are rechecked on every `!ap next` that falls back to them, so the order they arrive in
does not matter.** Sphere data was first loaded once per seed and held for the life of the watch.
That made the priority above only true at load time: drop a spoiler, let somebody run the command,
then extract the table, and the watch went on answering from the spoiler's tenth of the locations
until a restart, with nothing to say a far better source was sitting beside it. `ensureSpheres` now
compares a fingerprint of both candidate files (size and modification time, two stats and no reads)
and reloads only when it moved. Either half alone misses a case: a re-extraction can land on the
same size, and a copy tool can keep the old timestamp. The fingerprint is taken before the load, so
a file changing mid-load leaves one that is already stale and the next call catches it, rather than
one matching content that was never read.

Two rules keep a reload from breaking a call already under way, both found by review and
reproduced before they were fixed:

- **Each call answers from the record it chose.** `prepareSuggest` picks the sphere data and then
  awaits a multi-second tracker fetch; `ensureSpheres` returns the record, and `suggestFor` reads
  that snapshot rather than `state.spheres`. Reading the live field let a second `!ap next` in the
  gap drop it, and the first call threw `Cannot read properties of null`.
- **While the held record's own file is still on disk, a failed or downgraded load does not cost
  it.** Windows copy tools hold the destination open exclusively, so every read during a copy
  fails with `EBUSY`. That went wrong two ways, both reproduced with real `copy`, `robocopy` and
  `Copy-Item` runs: with nothing else to load, dropping the record told the user there was no
  sphere data with the file sitting right there; and with a spoiler beside the table,
  `loadSpheres` quietly fell back to it, so a copy over the table switched every answer to a
  tenth of the locations for its duration, and a location was seen vanishing from a reply
  mid-copy. Now, if the held record's own file is present (`sourcePresent`) and the load came back
  empty or lower-ranked (`sourceRank`), the held record keeps answering and its fingerprint is left
  alone so the next call tries again. The warning is logged once per state of the disk.
- **Once the held record's own file is gone, it is not answered from memory**, even if some other
  file is present. The first version of this rule asked whether *anything* was on disk, so deleting
  a wrong table while a spoiler with no Playthrough sat beside it changed nothing, indefinitely.
  An upgrade, a table appearing beside a held spoiler, always goes through.

**Checks and received items come from the tracker's JSON API, not its HTML.** The per-slot page
carries a plain `Location | Checked` table and was the first thing tried. It is not usable: a game
with a custom tracker in the web host renders something else entirely, and Super Metroid's page had
no such table at all, which is why one slot silently reported nothing checked. `/api/tracker/<id>`
answers identically for every game, in ids. `readProgress` takes both halves from one read:
`player_checks_done` for the checked location ids, which the client's data package turns back into
the names a spoiler uses, and `player_items_received` for what the logic worker evaluates, where the
server has already copied an item-link group's items to every member. Each received item is a
NetworkItem `[item, location, finder, flags]`, and `answerAll` sends the worker
`[item, location, flags]`: the location is what tells an item handed out by `/send` or `!getitem`
(location -1) from one somebody found (see "The logic worker").

Spoilers are gitignored with the rest of `data/archipelago/`, and parsed so the item and receiver
columns are dropped where they are read rather than carried around and filtered later.

### Data package caching

`RoomInfo` carries a checksum per game. Each is looked up in `data/archipelago/datapackage/<game>-<checksum>.json` first, and `GetDataPackage` is sent only for the games that missed. Some games ship id tables in the megabytes, and without the cache every reconnect would re-download all of them. Cache files are disposable; delete any and the next connect refetches it.

### Files

| File | Role |
| ---- | ---- |
| `commands/archipelago.js` | `!ap` / `/ap` (alias `!archipelago`). Subcommands: `watch`, `list`, `status`, `unwatch`, `filter`, `progression`, `skipgoaled`, `infer`, `color`, `markers`, `claim`, `unclaim`, `claims`, `pings`, `hintpings`, `next`, `hints`, `goals`, `leaderboard`, `password`, `retry`, `catchup`. Open to everyone: the read-only `list`, `status`, `claims`, `goals`, `leaderboard`, `next` (it answers only for the caller's own claims) and `hints`, and `claim`, `unclaim`, `pings` and `hintpings` acting on the caller's own slot. Everything else is owner-only when `config.ownerId` is set. |
| `helpers/archipelagoClient.js` | Socket, handshake, reconnect, `PrintJSON` rendering, slot name lookups. |
| `helpers/archipelagoMonitor.js` | Watch store, batching, the per-watch serial pipeline, Discord relay, catch-up runs and their scheduling, status notices, ping policy. |
| `helpers/archipelagoCatchup.js` | What each watch has posted, per watch and seed, and the pure diff and render that rebuilds missed lines from a tracker read. |
| `helpers/archipelagoClaims.js` | Slot claim storage and lookup. |
| `helpers/archipelagoGoals.js` | Lifetime goal tally, keyed by seed and slot. |
| `helpers/archipelagoRoles.js` | Participant and goal-count Discord roles. |
| `helpers/archipelagoData.js` | Data package disk cache. |
| `helpers/archipelagoLogic.js` | Locates, starts, talks to and stops the logic worker behind `!ap next`. |
| `helpers/archipelagoSpheres.js` | Sphere data and the sphere 1 fallback. |
| `scripts/ap-logic-worker.py` | Rebuilds a seed's logic from the Archipelago install that generated it and answers what is in logic. Started by the bot, on the install's own Python version; writes nothing into the install. |
| `scripts/extract-spheres.py` | Run by hand: lifts a multidata's sphere table into `data/archipelago/spheres/<seed_name>.json` for the fallback. |
| `data/archipelago_watches.json` | Watches added with `!ap watch`, never the configured room. Gitignored: it holds the room URL, the Discord channel and user ids, and a room password in plain text if one was set. Overridable with `PLEXBOT_AP_WATCHES_FILE`, which is required under the test runner so a test run cannot read or rewrite the real one. |
| `data/archipelago_claims.json` | Slot claims, including the configured room's. Gitignored: it maps Discord user ids to slot names. Overridable with `PLEXBOT_AP_CLAIMS_FILE`, required under the test runner on the same terms as the watch file. |
| `data/archipelago_goals.json` | Lifetime goal tally per Discord user id. Gitignored. Overridable with `PLEXBOT_AP_GOALS_FILE`. |
| `data/archipelago_roles.json` | Ids of the roles the bot created, per guild. Deleting it orphans those roles rather than breaking anything: the bot makes fresh ones and stops managing the old. Overridable with `PLEXBOT_AP_ROLES_FILE`. |
| `data/archipelago_catchup.json` | Per `<watchId>::<seed>`: the item, goal and hint keys already posted or filtered, when the baseline was taken, the last successful post, and the finished slots at that moment. Gitignored. Deleting it costs one silent baseline per watch on the next catch-up, and anything missed before that is not posted. Records for a watch are dropped when it is unwatched, and a new seed on the same watch replaces the old one's. Overridable with `PLEXBOT_AP_CATCHUP_FILE`. |

---

## Playing a saved playlist

A `.playlist` file stores each track as `{artiste, titre, cle}`, where `cle` is a Plex part key of
the form `/library/parts/<partId>/<updatedAt>/file.flac`.

**That key is not durable.** It only means anything while the library row behind it does, and the
row changes whenever the file moves: a re-scan, a re-import, or a drive changing letter. A
playlist saved months ago is a list of paths into a library that has moved on.

**Plex answers a dead key with an HTML 404, and `fetch` does not throw on one.** So the 85-byte
error page became the audio resource, ended instantly, the player went Idle and the queue
advanced. A 47-track playlist drained in about ten seconds with nothing written to any log,
because as far as JavaScript was concerned nothing had failed. That is the shape of the bug this
section exists to prevent, and `Bot.openPlexStream()` is where it is caught:

1. Fetch the stored key. `response.ok` decides whether it is audio, not whether the request
   completed.
2. On a failure, look the track up again by title and artist through `helpers/plexResolve.js`,
   which are the durable half of a saved entry.
3. If that yields a **different** key, retry once. A lookup that returns the same key that just
   failed is not retried; that is what a library still pointing at a missing file does, and
   fetching it again would only waste a round trip.
4. Otherwise report the track and skip it.

A repair updates the queue entry, so a replay uses the working key, and is written back into the
playlist file it came from by `persistKey()` so the search is paid once rather than on every play.
Entries carry a `playlist` field for that, set when the queue is built. The write goes through a
sibling temp file and a rename, and never throws: playback has already succeeded by then, and
failing to record the repair is not worth interrupting it for.

**Matching refuses to guess.** `bestMatch()` requires the artist to agree, because a search for a
common title returns every cover in the library and queueing the first would quietly play the
wrong recording. With no artist recorded, exactly one title match is accepted and two are not.
Titles are compared with case, punctuation and apostrophes folded away, since a stored title and a
Plex title rarely agree byte for byte.

**Reporting is capped.** A wholly broken library means every track fails, and 47 individual
complaints would be worse than the silence they replaced. The first three are named, the rest are
counted, and one summary at the end says how many and that a re-scan is probably what is needed.

## Seeking within a track

`!seek` flags the playing entry with `isSeeking` and `seekOffset`, then force-stops the player.
Idle is also how a track ends normally, and until September 2026 nothing read either flag, so the
Idle handler shifted the queue and every seek advanced to the next track, like `!skip`.

`helpers/seek.js` holds the three decisions, covered by `test/seek.test.js`:

- `afterTrack(queue)` chooses between replaying the head, advancing and finishing. A pending seek
  replays the entry the way `!loop` does. It is keyed on `isSeeking`, so `!seek 0` restarts the
  track instead of skipping it.
- `takeSeek(track)` returns the offset once and clears both flags. `runPlayback` calls it on the
  entry it fetched, once the Plex fetch resolves, so a seek that lands while the next track is
  loading applies to that track instead of lingering on the entry until it ends and then replaying
  it.
- `seekArgs(ms)` builds the ffmpeg arguments.

`!seek` refuses an offset past `Number.MAX_SAFE_INTEGER` milliseconds. ffmpeg rejects a `-ss` that
large, and the player's error and Idle handlers then both advanced the queue, skipping a track
nobody asked to skip.

**The offset is applied by an ffmpeg the bot starts itself.** `createAudioResource` runs its own
ffmpeg for a plain stream and takes no extra arguments. `Bot.seekResource()` pipes the Plex download
into a prism-media `FFmpeg` that encodes Ogg/Opus with libopus, the route voice also takes for a
normal track with ffmpeg-static, and hands it over as `StreamType.OggOpus` so voice only demuxes
it. A track with no seek still goes through `createAudioResource(readstream)`, unchanged.

Measured with ffmpeg-static 4.4.1 on generated clips, served over HTTP and read the way the bot
reads Plex:

- **`-ss` goes after `-i -`.** The input is a pipe, which ffmpeg cannot seek. As an input option,
  `-ss` started Ogg Opus 0.5 s late at 10.5 s and 1 s late at 25 s, and Ogg Vorbis ignored a
  25-second seek and started 1 s in. As an output option ffmpeg decodes and discards up to the
  offset, and the start landed exactly in FLAC, MP3 (CBR and VBR), M4A (AAC and ALAC), WAV, Ogg
  Vorbis and Ogg Opus.
- **ffmpeg's `'finish'` says nothing about the audio.** It fires once the download has been written
  into it, 16 seconds before the end of a 19.5-second seeked clip in one run. Nothing ends a track on
  it (see "Quirks worth knowing").
- **The download is joined to ffmpeg with `stream.pipeline`.** On Idle the player destroys ffmpeg
  either way. The difference is a download that fails mid-track: with `pipeline` the error reaches
  the player at once, as it does for a normal track. With `.pipe` the player played out ffmpeg's
  buffer and then 5 s of silence before going Idle and advancing as if the track had finished.
- **ffmpeg is killed when voice closes the stream.** prism kills its ffmpeg only while stdin is
  open. A `!skip` after the whole download had gone in, but before the audio had played out, left
  ffmpeg blocked writing to a stdout nobody reads, still running 45 s later. A normal track leaks
  voice's own ffmpeg the same way; that path is untouched by this change.

A seek while paused resumes playback at the new position. **A plain `stop()` on a paused player does
not reach Idle until the player is unpaused**: it only arms the resource's trailing silence, and a
paused player reads no frames to play that out. `!seek` forces its stop. `Bot.stop()`, behind
`!skip`, `!stop`, Hitster and the playback buttons, unpauses a paused player and then stops it
unforced, so it goes Idle in its own time as a playing one does: 30 ms after `!skip` in a run
against the real player, with no audio sent in between, because the connection is already gone.
Both clear `isPaused`, since the next track gets a new player. Until October 2026 `Bot.stop()` did
neither, so a `!skip` or `!stop` after `!pause` waited for `!resume`: the queue stayed put, and
`isPlaying` stayed true, so a later `!play` only queued.

A forced stop in `Bot.stop()` was tried and dropped. It goes Idle inside the call, so the next
track has started before `Bot.stop()` returns. `!hitster stop` during a turn calls `Bot.stop()`
twice, once from `resolveTurn` through the collector's synchronous `'end'` and once itself, and the
second call skipped the music track the first had just started. The unpause emits `'playing'` again,
which `runPlayback`'s now-playing listener ignores after a player's first. Until October 2026 that
listener also re-posted the now-playing embed on every `!resume`. Covered by
`test/playbackPause.test.js`.

**A stopped player that is still Buffering goes Idle late, usually by way of Playing.** It ignores
the stop until ffmpeg's output turns readable, goes Playing, and goes Idle on the next 20 ms audio
cycle, because the stop destroyed the connection and the player's `noSubscriber` behaviour is Stop.
A download that fails first takes it straight from Buffering to Idle, after an `'error'`. Until
October 2026 its listeners acted on whatever was at the head by then. A `!skip` while buffering
posted the skip, then a now-playing embed with live controls for the skipped track, then the next
track's. After `!stop`, `isPlaying` stayed true until the late Idle, so a `!play` in between only
queued its track; the late Playing announced it and the late Idle ended it as if it had played, so
it was announced, never downloaded, and dropped. Both reproduced against the real player,
`createAudioResource` and ffmpeg-static, with the download held back to keep the player Buffering.
A stop now counts against the player that was current when it landed (`stopped()` in
`runPlayback`):

- Its now-playing listener announces nothing. `announced` stays false, so a loop or seek replay of
  that entry is still announced when it plays.
- Its `'error'` listener only logs. It used to post "Playback failed" for the head, which after
  `!stop` and `!play X` named X while X went on to play.
- **Its Idle ends the stopped entry only while that entry is still the head and no newer run has
  started.** A track queued after `!stop` is never its to end, whether the `!play` started a run of
  its own or could not: a requester outside voice gets "Join a voice channel first", and `!artist`
  queues album by album and starts playback after the last lookup.
- `Bot.stop()` sets `isPlaying` false when the stop leaves the queue empty, which only `!stop` does,
  so the next `!play` starts a run at once rather than queueing behind the stopped player.

A Hitster clip run that was loading when the stop landed handles it in `superseded()`.
`superseded()` used to hand that stop to the music player's Idle whenever the music had not reached
Idle yet. That Idle now leaves the queue to the newer run, so the clip run handles the stop itself,
**once its Plex request answers**. The music resumes that much later than before: with Plex
answering 50 ms after the stop, A was requested again 63 ms after it, where the old code took 3 ms.
Letting the stopped music player take the stop over instead, and cancel the clip run, could emit
`'finish'` twice or leave the bot in the voice channel when the queue ended there.

An older player that ends on its own while a newer run loads still runs its own `dispatcherFunc`,
as before. Covered by `test/playbackBufferingStop.test.js`, whose FakePlayer stays Buffering after
an unforced stop until the test makes its output readable or fails its download. The FakePlayers in
`test/playbackRace.test.js` and `test/playbackPause.test.js` go straight from Buffering to Idle.

**Still open:** a run that starts after a stop which left the queue non-empty does not act on that
stop. Hitster's next turn does this when the previous clip, stopped by a guess, is still Buffering
3 s later, and so does a turn starting right after a `!skip` of buffering music. The stopped entry
stays queued behind the new clip and plays after it. The old code was worse here: the late Idle
shifted the new clip, so the turn played the wrong song. The same leftover entry already came from
a stopped player that a newer run force-stops before it reaches Playing.

Known costs:

- **A seek downloads the file again from byte 0** and decodes up to the offset. Over loopback, a
  seek 540 seconds into a 10-minute FLAC started in 0.8 s. At about 2.3 MB/s the same seek took
  13.3 s.
- Until ffmpeg reaches the offset the player is Buffering, and the track after a `!skip` sent then
  waits for it. A `!play` after a `!stop` does not. A `!pause` sent then is refused, as it is for
  any track still buffering.
- Seeking past the end produces no audio, and the queue advances as if the track had finished.
- An M4A with its index at the end of the file plays neither normally nor seeked, because ffmpeg
  cannot reach the index through a pipe.

Handing ffmpeg the Plex URL (`-ss N -i <url>`) would seek with range requests, taking 0.2–0.34 s at
60, 300 and 540 s into the same FLAC, and would read a trailing M4A index. It was left out because
it bypasses `openPlexStream()`'s dead-key repair and puts the Plex token on ffmpeg's command line.
The audiobook player does hand ffmpeg a URL, and answers both objections in its own way: a
loopback proxy keeps the token off the command line, and a probe plus a key repair replaces
`openPlexStream()`'s (see "Audiobooks and podcasts").

## Audiobooks and podcasts

Off unless `audiobooksEnabled` is set. `/book` (alias `!books`) plays long-form audio that lives
in the Plex **music** library, with a saved place per listener per work, chapters, speed, a
sleep timer, a shelf and listening stats. Built and unit-tested offline: 398 tests in 24 files
belong to the suite (all 1,173 in `npm test` pass). The exclusion filters, the gate and the
engine's guards were mutation-checked, each removed in turn with its test failing; the one
survivor is `startAt()`'s entry check, a deliberate second line of defence behind the timer
clearing. A contract test runs the real ffmpeg-static through the real proxy. **It has not been
exercised against a live Discord voice channel and a live Plex server yet**; Phase 7 of
`BUGTESTING.md` is the checklist that does.

### The engine

Book parts could have ridden `songQueue` and `runPlayback`. That was rejected: it puts about 85
lines inside the most race-fixed code in the bot, gives books music's `NoSubscriberBehavior.Stop`
(a voice blip ends the part), a fresh voice join on every `!skip`, and a sleep timer that would
drop other people's queued music. Instead `helpers/bookEngine.js` runs **one session per guild,
with its own `AudioPlayer` and its own voice join**, and shares only the guild's voice with music.

The engine never reads or writes `bot.dispatcher`, `bot.conn`, `bot.isPlaying`, `bot.isPaused`,
`playRun`, `stopGeneration` or `stoppedEntry`. It calls `bot.musicBusy()`, `bot.openConnection(channel)`
and, after an explicit `/book stop` only, `bot.playSong()`, and reads `bot.songQueue.length` for
the card.

The session's player is `NoSubscriberBehavior.Pause` with `maxMissedFrames` 750 (15 s). Pause
means a voice blip auto-pauses and resumes on Ready, with the position frozen. The 15 s leaves
room for ffmpeg's `-reconnect` to resume a dropped Plex request through a Range request: in the
prototype a deliberately dropped request played 120.00 s of 120 with reconnect and 24.82 s without.

Three rules carry most of the weight:

- **Every seek, chapter jump and speed change is `player.play(newResource)`**, which emits no Idle
  and kills the old ffmpeg. So Idle only ever means "this part's stream ended" or "it failed".
- **Pause parks.** ffmpeg is killed and only the position is kept, so a paused stream holds no
  Plex socket and cannot die overnight and come back as an unasked-for retry. Resume builds a new
  resource in 0.2–1.6 s. The Idle handler acts only while the session is `playing`, and only for
  the resource it built.
- **`startAt()` moves the anchor and drops the resource before its first await.** A periodic save
  or a stop during a build writes the target, never "the next part plus the old offset". The
  newest call wins, so rapid ±30 s clicks compose and nothing stale spawns.

Sessions go `starting` → `playing` ⇄ `paused` → `ended`. The session exists, and claims the guild,
synchronously from the moment `/book play` passes its checks, before the voice join: the gate
refuses music from that tick on, a second `/book play` from the same person gets "Still joining
the voice channel, one moment.", and every control except stop gets the same answer, because the
player and connection do not exist yet. A stop during the join saves nothing (nothing was heard,
and the bookmark stays byte-identical), releases the claim in a `finally`, and the late connection
is destroyed only when nothing newer could be using it, since `joinVoiceChannel` hands an existing
Ready connection to the next caller. Switching books is a stop plus a fresh join (0.6 s median),
never a reused connection: an AutoPaused player on a destroyed connection hangs forever.

**How a part's end is read** (`bookModel.classifyPartEnd`, pure). `resource.ended` is never used:
silence padding makes it true after any unforced stop. Instead the engine reads whether the stream
reached end-of-stream (`playStream.readableEnded`) and how far it got:

| Verdict | When | Action |
| ------- | ---- | ------ |
| natural | end-of-stream within 5 s of the part's end, or the same short end-of-stream twice in a row from the same spot within `max(10 s, 1%)` of the end. Plex's duration can overstate the file: one part reported 31,730,164 bytes and served 31,656,436. | next part on the same player (no voice join); on the last part, finish the work |
| natural, with sleep "end of chapter" | every part end is a chapter end | stop with reason `sleep`, place saved at the next part's start |
| truncated | the same two short end-of-stream reads anywhere earlier in the part | park with "The file for Part N ends early at …". Never a skip, never a finish. |
| early | no end-of-stream (a stall through `maxMissedFrames`, a stream error, a dead key, the Buffering watchdog, a probe timeout), or end-of-stream with real time left | retry from the position after 1 s. Three early ends that produced under 10 s each within 2 minutes park the book with "Plex stopped sending audio 3 times in 2 minutes." |

`classifyPartEnd` returns the new failure list instead of mutating its input, and the engine keeps
it (`s.failures = verdict.failures`), or the three-in-two-minutes rule would never fire.

**Watchdogs.** An `AudioPlayer` in Buffering has no timeout of its own, and ffmpeg waits forever on
an upstream that accepted a request and never answers (a stall prototype was still Buffering after
60 s). Three layers bound it: the probe gives up after 5 s, the proxy answers 504 if Plex sends no
headers within 15 s, and a 20 s Buffering watchdog kills the resource and takes the early-end path.
The retry and watchdog timers live on the session and are cleared by park, stop and every
`startAt`, and `startAt` refuses a session that is no longer live, so a retry that fires after a
pause or stop builds nothing, saves nothing and spawns no ffmpeg.

**Voice and presence.**

- A blip (Signalling or Connecting): the player auto-pauses and resumes on Ready. If the stream
  died meanwhile, Idle and the early-end retry rebuild it once the connection is back.
- Disconnected: a 5 s grace for a move or a resumable drop, then park, save and end with reason
  `voice-lost`. Destroyed: the same at once. However the status flaps, 30 s away from Ready in
  all ends it the same way.
- The bot is moved to a channel the listener is not in: the listener has 5 s to follow, then the
  book parks with reason `listener-left`.
- Something else subscribes to the book's connection: the player's `'unsubscribe'` parks and
  saves with reason `unsubscribed` (the card: "Something else took over the voice connection.").
- The listener leaves the book's channel: park with reason `listener-left`. Rejoining does not
  resume; the card shows Resume.
- A parked book leaves voice after `audiobookIdleLeaveMinutes` (10) with reason `idle`.

Stop reasons: `explicit`, `generic`, `sleep`, `idle`, `voice-lost`, `finished`, `failed-file`,
`shutdown`, `switched`, `join-failed`, `forgotten`. Only `finished` marks a work finished.
`forgotten` saves nothing, and neither does a stop during the join; `finished` writes through
`markFinished` and then saves nothing smaller over it. `stop()` releases the session in a `finally` with an identity check, so
a throw in the final save cannot leave the guild blocked for music until a restart.

**Timers follow audible time.** The sleep timer and the end-of-chapter timer are stashed on park,
on AutoPaused and on every rebuild, and re-armed when the player reaches Playing, so neither runs
during a 0.2–1.6 s startup or a voice blip. The chapter timer is armed only when the chapter ends
more than 250 ms before its part does; a part end belongs to Idle, so the two never race. When it
fires early (a blip, a slow start) it re-arms for the remainder instead of acting.

**Permissions.**

| Who | May |
| --- | --- |
| The listener (who ran `/book play`) | everything |
| The bot owner (`config.ownerId`) | pause, stop |
| Anyone in the book's voice channel while the listener is not in it | pause, stop |
| Anyone | their own shelf, `/book library`, `/book stats`, `/book leaderboard` |

Bookmarks always follow the listener, never the person who clicked.

**The card.** One public message per session, sent with `textChannel.send` rather than as an
interaction reply, so it stays editable after the 15-minute interaction token expires. It is
edited on every state change and every 120 s while playing, at most once per 1.5 s with a
trailing edit. Row 1: previous chapter, back 30 s, Pause/Resume, forward 30 s, next chapter.
Row 2: speed (cycles 1, 1.1, 1.25, 1.5, 1.75, 2), sleep (cycles off, 15, 30, 60 min, end of
chapter), Stop. Every live-card custom id is `book:<action>:<sessionId>`; a click on a card from
an earlier session gets its buttons stripped and an ephemeral "That card is from an earlier
session." The ended card carries `book:resume:<workId>`, `book:shelf` and, when the listener
stopped within 120 s of the end, `book:finish:<workId>:<listenerUserId>` ("Mark finished",
listener only; the user id is in the custom id because an ended card has no live session to say
who the listener was). A 10008 or 50001 edit failure drops the card and the next event posts a
fresh one; `/book now` always re-posts and turns the old one into "This card moved ↓".

### Reading Plex: ffmpeg on a URL, through a loopback proxy

**The trap.** The music path downloads the file and pipes it into ffmpeg. A pipe cannot seek, so
every seek downloads the file again from byte 0 and decodes and discards everything before the
offset (see "Seeking within a track"), five hours of it to resume five hours into a book.
`Readable.from` in that path buffers the whole file in memory: 820 MB for one m4b. An m4b with its
index at the end plays 0 s through a pipe.

**The fix** (method B, `helpers/bookAudio.js`). ffmpeg reads the part from a URL, with the seek as
an input option:

```
-nostdin -loglevel 0 -reconnect 1 -reconnect_on_network_error 1 -reconnect_delay_max 5
[-ss <seconds>] -i <url> -analyzeduration 0 -vn [-af atempo=<speed>]
-acodec libopus -f opus -ar 48000 -ac 2 pipe:1
```

- `-ss` before `-i` seeks with range requests: exact to the sample on m4b and on CBR and VBR mp3,
  0.2–1.6 s to first audio at any depth. Under `atempo` the input seek is still in source time
  (0–6 ms error measured from 0.8x to 2x). The contract test checks `-ss 2` at 2x on a 20 s WAV
  decodes 9.0 s within 50 ms; with `-ss` after `-i` it decoded 7.998 s.
- Offset 0 uses the same path, so an m4b with a trailing index plays.
- Never `-usetoc`, never `-headers`, never a byte-range estimate.
- Speed is `atempo`, pitch-preserving, 14 values from 0.75x to 3x.
- Not changed, flagged: `-analyzeduration 0` sits after `-i`, so ffmpeg reads it as an output
  option and the input still runs its default 5 s stream analysis. Over Plex that is only bytes,
  but moving it before `-i` might cut resume latency. Measure live before changing it.

**The token.** A URL to Plex needs the token, and an ffmpeg command line travels further than a
file: Task Manager during a screen share, crash dumps, AV telemetry, diagnostic transcripts, and
`/proc/<pid>/cmdline` on Linux, which any user can read. `helpers/partProxy.js` is a loopback
proxy that adds the token itself, as an `X-Plex-Token` header:

- `http.createServer` on `127.0.0.1`, port 0, started lazily by the first probe and closed by
  `shutdown()`. If it cannot bind, the probe reports `error`, which counts as an early end, so the
  book parks after three tries with "Plex stopped sending audio"; the next probe tries the bind
  again. Music is unaffected.
- ffmpeg gets `http://127.0.0.1:<port>/<secret>/library/parts/<id>/<ts>/<file>`, where the secret
  is 128 random bits per boot. Only GET and HEAD on that shape are forwarded, only when the Host
  header is exactly `127.0.0.1:<port>` (a DNS-rebinding guard), and a last segment that decodes to
  `.`, `..` or a slash is refused. Everything else is 404. What could leak reads audio parts, from
  loopback, while this process runs.
- `Range` and `If-Range` go up; status, `Content-Range`, `Content-Length`, `Accept-Ranges` and
  `Content-Type` come down. Plex unreachable is 502. A client disconnect aborts the upstream.
- The 15 s timeout covers the wait for **headers** only, as a timer cleared on the response.
  `ClientRequest.setTimeout` would have been a socket idle timeout that keeps running after the
  headers arrive; once ffmpeg's output backs up (the player reads in real time) a healthy upstream
  can sit idle longer than 15 s, and it would have cut parts mid-body.
- `probe(partKey)` sends `Range: bytes=0-0` (3–8 ms; 206 live, 404 dead), with a 5 s timeout.
- `config/plex.js` is read per request, so a test never needs the real config.
- Measured cost: one loopback hop, 0–150 ms, inside the noise.

**ffmpeg is spawned directly** (`helpers/bookResource.js`), not through prism's `FFmpeg`, because
prism spawns with `{ windowsHide, shell }` only and cannot change the environment. ffmpeg-static
4.4.1 routes even `127.0.0.1` through `http_proxy`: with the proxy variables left in, the contract
test's ffmpeg hung past 10 s. `ffmpegEnv()` drops `http_proxy`, `https_proxy` and `all_proxy` in
any letter case (Windows env names are case-insensitive). stdout becomes an `AudioResource` with
`StreamType.OggOpus`, and ffmpeg is SIGKILLed when voice closes the stream, the same close rule as
`Bot.seekResource()`.

**Dead keys.** Part keys change whenever Plex re-scans. Before every build the engine probes the
key; a 404 goes to `bookLibrary.repairPartKey(work, part)`, which reads
`/library/metadata/<trackRatingKey>` and accepts `Media[0].Part[0].key` only when its file basename
matches. It never uses `/search`: a title search picks among duplicates, and the same artist and
title exist many times over across narrations and re-rips. If the ratingKey itself is gone, a
rebuild is scheduled and the session ends with "Plex can't find the file … Your place is saved."
Part keys are looked up by identity (`partKeyFor(workId, { trackRatingKey, file })`), never by
ordinal: a rebuild during a session can insert or reorder parts, and an ordinal lookup would play
a different file at the old offset.

### The catalog: folders first, never track length

On a hand-ripped library a Plex album is not a book. Several books share one album title, one
album holds the second half of one book and the whole of another, one book is spread over several
albums under several artist spellings, and numbered volumes are poured into one flat folder. What
does line up is the folder on disk, so `helpers/bookCatalog.js` groups tracks by folder first
(a trailing `Part 2`, `Disc 3`, `[01]` or `(1 of 6)` on a folder is folded into its parent) and
uses Plex albums second.

A folder group becomes a work when it holds at least 2 h of audio and one of these holds:

| Kind | Rule |
| ---- | ---- |
| podcast | at least half its tracks carry an episode number, and the median track is 20 min or longer |
| book | the median track is 15 min or longer |
| book | a name signal (GraphicAudio, unabridged, audiobook, narrated, "read by") and at least 3 h |
| book | at least 80% mono at 96 kbps or less, 20 or more tracks, and at least 3 h |

Everything else is music, and the near misses of 2 h or more are listed by `/book rescan` as
"long groups not taken as books". Ids are slugs, `author/title`, with `~narrator` added only when
two narrations collide. Part order is natural sort; several numbered volumes poured into one
folder are untangled by chapter numbers and marked low confidence, and a `partOrder` override is
the fix. Sample clips under 5 minutes are dropped from playback but stay in the index, so they
never reach music. `RULES_VERSION` (1 today) forces a rebuild when the rules change.

**Chapters.** Only mp4, m4a and m4b parts, and parts over 2 h, are asked for chapters
(`/library/metadata/<rk>?includeChapters=1`), cached by `trackRatingKey:sizeBytes`. A list is kept
only with 2 or more entries whose end is after their start; the 5-minute "Marker N" point lists
seen on mp3s are dropped. A part without embedded chapters is one chapter.

**Refresh.** A full listing costs about 17 s and 25 MB, so it runs only when something says the
library changed: no catalog yet, the rules changed, the build is over a day old, or a music
section's `scannedAt`, `updatedAt` or track count moved. The cheap check behind that (one
`/library/sections` call and one zero-size count per music section) runs hourly while
`audiobooksEnabled` is on, so a book added while the bot runs for days stays out of music within
the hour; `/book play` runs it at most once an hour; `/book rescan` forces a rebuild. A rebuild
refuses while any music section is `refreshing`, even when forced, because a mid-scan listing can
miss folders and leak books into music, and an empty listing or a build with no works never
replaces a catalog that has some (an unmounted drive) unless forced. If a rebuild fails the last
catalog stays in use and `/book play` adds "(The library list may be stale: the last refresh
failed.)".

After a rebuild, `matchAliases` maps old ids to new ones by `trackRatingKey` or a basename
overlap of at least 50%, records them in `aliases`, and a bookmark found under an alias is re-keyed
to the new id when it is next read. A running session keeps its snapshot of the work and looks its
part keys up by identity in the new catalog.

**Overrides** (`data/book_overrides.json`, hand-edited, read only). Read with `readFileSync` and
`JSON.parse` on each build. A parse error is logged, ignored, kept in `meta.overridesError` and
reported by `/book rescan`.

```json
{
	"authors": { "<author-slug>": { "series": "Series Name", "order": { "first title": 1, "second-title": 2 } } },
	"works": {
		"<detected id>": {
			"title": "", "series": "", "sequence": 2.5, "narrator": "", "edition": "",
			"partOrder": ["01 file.mp3", "02 file.mp3"], "exclude": true, "pinId": "stable/id"
		}
	},
	"include": ["<folderKey or albumRatingKey>"],
	"exclude": ["<folderKey or albumRatingKey>"],
	"podcastArtists": ["<artistRatingKey>"]
}
```

- `works` entries are keyed by the **detected** id, which is computed before overrides apply, so a
  `title` or `pinId` override cannot stop its own entry from matching on the next build. `pinId`
  gives the work a stable id and keeps the detected id as an alias. Empty strings are ignored;
  `null` clears `series`, `narrator`, `edition` or `sequence`. A partial `partOrder` puts the
  listed files first and keeps the rest after them in their old order.
- `authors.<slug>.order` matches titles by slug, so `"the fall of x"` and `"the-fall-of-x"` both
  work. Without `order`, `series` fills only works that have none.
- `include` and `exclude` take a folder key exactly as `/book rescan`'s rejected list prints it, or a
  work's `folderKey` (slash direction and case ignored), or an album ratingKey. The rejected list
  prints a key from below the music root (or its last two folders), so the drive and the folders
  above it stay out of the channel; `bookCatalogStore.readOverrides` widens such a short key to
  the one full key from the last build that ends with it. A short key that fits two folders is
  left as typed (and logged), so it needs the full path. For a box set merged
  from sibling folders, the folder key is the parent folder. An album `include` carves that
  album's tracks out of their folder into a work named after the album.
- `podcastArtists` is additive. The artists of every detected podcast are already excluded from
  music at artist level, so a new episode album stays out of music before any rebuild sees it; this
  only adds artists the detector missed.

### Bookmarks and what counts as finished

One flat record per `<discordUserId>::<workId>` in `data/book_bookmarks.json`: `absoluteMs` (ms
from the start of the work, the truth), a `hint` that pins it to a file (`ordinal`, `file`,
`sizeBytes`, `durationMs`, `trackRatingKey`, `partMs`), `speed`, `listenedMs` (real time),
`coveredMs` (book time, listened time times speed), `finished`, `finishedCount`, `finishedAt`, the
`guildId` of the last save, and timestamps. Part keys are never stored.

**Saves.** Every `audiobookSaveSeconds` (15) while playing, written only if the place or the
listening time moved by 1 s or more. Forced on start, every seek, pause, stop for any reason, part
advance, finish, sleep, voice loss, the listener leaving, an unsubscribe, a speed change, a switch
and `shutdown()`. Nothing relies on the `'exit'` event, which `stop-bot.ps1`'s `Stop-Process
-Force` and `!restart` never fire, so a hard kill loses at most one save interval, and the resume
rewind hides most of that. A `record()` with a non-finite position is refused and logged, so no
caller can write `NaN`.

**Durable writes.** A power cut or a BSOD can leave NTFS with a renamed file of zero length, which
`jsonStore` would quarantine and start empty, losing every listener's place. The bookmark store is
`durable`: the temp file is fsynced before the rename (1–3 ms on an SSD at a 15 s cadence), at most
once an hour the current file is copied to `.bak` first (only if it decodes, so a damaged file can
never replace a good backup), and a damaged main file is quarantined to `.corrupt-<ts>` and loaded
from `.bak` with `Restored Audiobook bookmarks from the hourly backup …`. A missing main file still
starts empty, so deleting it still resets. A failed write keeps the newer place in memory, retries
on the next save, sets `healthy()` false (the card shows a warning) and records `book-save-failed`
once per streak. Nothing is rolled back: rolling back would replay the same minutes on the next
resume for a disk fault.

**Resume** (`resolveBookmark`, first match wins): the hint's `trackRatingKey` and file basename;
then basename plus size; then a unique basename; then `absoluteMs` located in the current parts,
which survives an m4b re-ripped as mp3s. `hint.partMs` keeps the place inside the same file when an
override reorders parts. A place within 5 s of its part's end starts the next part at 0. A work
missing from the library stays on the shelf, marked. After a gap of more than 5 minutes the resume
rewinds `audiobookResumeRewindSeconds` (10), three times that after 24 h, and never at 0 or at the
start of new material, where it would replay the end of the old.

**Finished.** Only three things finish a work: the last part ending naturally, `/book finish`, and
the ended card's "Mark finished". No stop reason finishes anything. The rejected alternative was a
window near the end: on a 37 h 05 m book, `max(120 s, 0.5%)` is 667 s, so a sleep timer or a
`/book stop` 11 minutes before the end would have restarted the book next time. "Mark finished"
appears when the listener stops within 120 s of the end. Finishing is idempotent (a double click is
one finish), sets the place to the end and points the hint at the last part's end.

Where `/book play` starts (`resumeStart`):

| Case | Start |
| ---- | ----- |
| `from-start` | 0 |
| no bookmark | 0 |
| in progress | the resolved bookmark, with the rewind |
| finished, and the work has grown since (a podcast with new episodes, a re-rip with an added part) | the first new material, "▶ N new episodes since you caught up" |
| finished otherwise | 0, "You finished this on …, starting again."; `finishedCount` is kept |
| finished, then moved back with `goto` | the resolved bookmark, no restart |

Known limit: a finished work moved back by `goto` to within 5 s of the end of an earlier part reads
as new material. The start position is the same; only the reply wording differs.

**Stats** are read from the bookmarks, never kept in a second file. Hours listened is the sum of
`listenedMs` (pauses and blips add nothing), book hours the sum of `coveredMs`. In progress means
not finished and at least 60 s in. The leaderboard lists users with at least one bookmark saved in
this guild, because the bot has no GuildMembers intent and `members.cache` is not a member list;
rows with no listening and no finishes are dropped.

### Music and books sharing a guild

Music and a book never hold one guild's voice at once.

- **The runPlayback gate.** `runPlayback` asks `bot.books.blocksMusic(message)` after its member
  check and before `pickVoiceChannel`. While a session exists in the guild (`starting` included)
  the gate leaves the track queued, clears `isPlaying`, `waitForStart` and `waitForStartMessage`
  (left true, the first would make every later producer queue silently and the second would
  restart a run the gate just refused), records `music-gated-by-book`, and answers the message
  exactly once, because every producer leaves the acknowledgement to `playSong`. On the slash path
  that reply is what closes "thinking…". The short line, "📚 Queued behind <name>'s book (N
  waiting).", is always sent; the long explanation is added at most once per 30 s per channel.
- **`/book play` refuses while `bot.musicBusy()`** ("Music is playing here. Stop it with !stop,
  then /book play"). `musicBusy()` deliberately ignores `bot.dispatcher`: after `!stop` a
  stopped Buffering player stays non-Idle for 9–78 s, but `Bot.stop()` has already destroyed the
  connection, so counting it would refuse `/book play` right after the user stopped the music.
  `loadingRuns` covers a first track that is still joining, which `isPlaying` misses because it is
  set only once the stream opens.
- **Queued music after a book (decision D1).** Only an explicit `/book stop` or the card's Stop
  hands voice back to queued music, through a plain channel-shaped message on the real text
  channel, never an interaction adapter whose token may have expired. Sleep, idle-leave, voice
  loss, finishing and a delegated `!stop` never start music.
- **Generic commands (D2).** `!pause`, `!resume`, `!skip` and `!stop`, and the old music card's
  Pause/Resume, Skip and Stop, call `bot.books.routeGeneric(cmd, message)` first. With a book in
  the guild and a caller who may act, the book is acted on: `!skip` is one chapter forward and
  ignores a count; `!stop` ends the book (reason `generic`) and also clears the music queue. A
  caller who may not act gets a refusal naming the listener: `!pause`, `!resume` and `!skip`
  change nothing, and `!stop` leaves the book playing but still clears the music queue. Only with
  no book in the guild do the music commands run as before. The old card's toggle asks the book for its state,
  because `bot.isPaused` is always false during a book and a parked book could never be resumed
  from it.
- **Hitster.** `helpers/voiceClaims.js` keeps the two apart both ways: Hitster claims a guild only
  while a game is in state `playing`, the audiobook from `starting` on. Hitster refuses create and
  start with "📚 <name> is listening to a book in this server. Hitster can start after `/book
  stop`." The claim label is a plain display name, never a mention.
- **Backstop.** If anything still subscribes another player to the book's connection, the book's
  player goes AutoPaused, not Idle, and its `'unsubscribe'` listener parks and saves.

### Keeping books out of music

Membership in the catalog, never duration. A length rule drops hour-long music mixes and still
misses books cut into 6-minute chapters. `longForm.enabled()` is true when
`audiobooksExcludeFromMusic` is not `false` and the catalog index is non-empty. The catalog is
built only while `audiobooksEnabled` is on, so a default install sees no change; once a catalog
exists, turning audiobooks off does not let books back into music, and only
`audiobooksExcludeFromMusic: false` does. Podcast artists are excluded at artist level, so every
album by that artist, a soundtrack album included, is treated as long-form unless an override
says otherwise.

**Plex-side**, where counts and paging matter, a fragment `album.id!=<a,b,…>&artist.id!=<x,…>` is
appended to the URL: `!list` browse (client filtering would break its full-page offset rule) and
`plexTags.countTracks` / `sampleRandomTracks`, which share one private URL builder so the two can
never disagree (`/vibe` discovery, `/tags coverage`). The fragment names only fully catalogued
albums and catalogued artists, so a partly catalogued album still reaches those listings; every
site that queues music filters client-side as well. The syntax comes from probes against a live
server before the build (17,569 tracks became 16,643, with `totalSize` and windowing correct). It
was not re-checked after the build, because the build had no Plex access.

**Client-side**, before any random pick:

| Site | Change |
| ---- | ------ |
| `!random`, `!mood` | filtered before the pick. `!random` on a library with only books answers "That library has no music to pick from." (it used to throw a TypeError that was only logged) |
| Hitster | the pool filter drops dated book parts, which covers the deal and every turn |
| Plex playlists | **smart playlists only** ("📚 Skipped N audiobook tracks in this smart playlist."). A regular playlist plays what you put in it. |
| `!play` search, `!list` search | music hits are numbered and queued as before; book hits become one line, "📚 Also in your books: Title (Author), `/book play title`". A page of only books says "Those are audiobook chapters, not songs." |
| `!album`, `!artist` | the first non-book hit, plus the redirect line when books were skipped; book albums and book tracks inside a chosen artist are skipped |
| `!playlist add` | refuses a book track with the redirect |
| `/vibe` | tag, sidecar and artist hits and the discovery loop, so no chapter reaches the queue, `recentPicks` or tag inference; "No matches" can end with the redirect line |
| `/sonic` | the section listing and the hub results, before the synthetic `!play` |
| `/quotethebard` | both item lists; a playlist of only books is refused |
| `!releasesurvival` albums, `!curate`, `!groupwatch`, `!quest` | display filters, on music sections only |
| `!identify` vault mode | each book collapses to one suspect ("An audiobook by …"), so 300 chapters cannot trip its 400-row safety limit |

Never filtered: `helpers/plexResolve.js` (key repair), `!identify`'s global-mode ownership check,
and the book suite itself.

### Failure modes

| Scenario | Handling |
| -------- | -------- |
| Voice blip | AutoPaused, position frozen, resumes on Ready; a stream that died meanwhile is retried from the position |
| Kicked, Disconnected for more than 5 s, or 30 s away from Ready in all | park, save, end `voice-lost`, card "🔌 Lost the voice connection" with Resume |
| Bot moved to a channel the listener does not join within 5 s | park `listener-left`; the card shows Resume |
| Music requested during a book | queued; one short reply; plays after `/book stop` or a bare `!play` |
| `/book play` while music plays, loads, joins or holds a connection | refused, with a hint to `!stop` |
| Plex accepts and never answers | 15 s proxy header timeout, then the 20 s Buffering watchdog; three short failures in 2 minutes park with a warning |
| HTTP drop mid-part | ffmpeg `-reconnect` resumes through Range; if it still ends early, retry from the position |
| File cut or corrupt mid-part | park with "ends early at …"; never a skip or a finish |
| Part key dead | probe 404, repair by ratingKey with a basename check, retry; ratingKey gone: rebuild scheduled, session ends with the place saved |
| Parts re-keyed, re-ripped or reordered | `resolveBookmark` tiers; `hint.partMs` survives a reorder |
| Folder renamed (id changes) | aliases on rebuild, bookmark re-keyed on read; `pinId` as a fallback |
| Pause or stop during a retry gap | retry timer cleared; nothing builds, spawns or writes after the stop |
| Stop during the voice join | no save, claim released, late connection destroyed only if nothing newer owns it |
| ffmpeg fails to spawn | logged, `book-stream-error`, stream ends, early-end policy |
| `!restart`, SIGINT, SIGTERM | `bot.books.shutdown()` first: synchronous saves, ffmpeg killed, voice left, proxy closed |
| `stop-bot.ps1` hard kill | at most `audiobookSaveSeconds` lost |
| Power cut during a bookmark write | fsync before rename; a damaged file loads from the hourly `.bak` |
| Bookmark write fails | place kept in memory, retried, card warning, `book-save-failed` once per streak |
| Catalog rebuild fails or Plex down at boot | last catalog stays; exclusion keeps working; `/book play` says the list may be stale |
| Card deleted or uneditable | next event re-posts; `/book now` always re-posts |
| Old card clicked | buttons stripped, ephemeral note |
| Autocomplete before a catalog exists | one explanatory choice; never calls Plex |
| Two bot copies | the single-instance lock refuses the second; without it two engines would double-save |

**Not built (phase 2):** a "stop the music and start my book" takeover button, stashing and
restoring the music queue, a sleep fade-out, "next in series", book volume (an ffmpeg `volume=`
filter), per-episode podcast marks, auto-resume on rejoin, and a shared-bookmark book club.

## Voice health and process priority

Two small pieces from a stutter investigation on 2026-10-09, after listeners reported choppy voice
audio. Neither changes how audio is produced.

**What the investigation measured.** System CPU sat at 74–98% during the timing runs, mostly
other test suites, so absolute gap sizes are upper bounds for a quieter machine. Ranked by
evidence and by how often each can fire:

1. **Wi-Fi link interruptions on the host.** The PC was on Wi-Fi only. Over 48.8 days its
   Wi-Fi log held 154 security-renegotiation events of about 4.2 s each and 31 driver disconnects;
   15 fell during playback, 7 of them within 2.5 minutes. About one per 10 playback-hours, but they
   cluster. One disconnect lined up with the only voice join over 2 s (12.6 s).
2. **The bot stalling its own 20 ms send timer at the start of long tracks.** `Readable.from` in
   object mode (`app/bot.js:898`) pulls the whole file on the main thread. Against the real
   `AudioPlayer` on a 7 h file: 23–29 send gaps over 40 ms, packets up to 1.83 s behind schedule,
   about 885 MB RSS. `Readable.fromWeb` on the same file: 0–3 gaps, 81–131 MB. It persists at
   raised priority, so it is self-inflicted.
3. **Other programs starving the bot.** A pure scheduler loop at Normal priority had gaps up to
   359 ms (31 over 40 ms); at Above Normal, 34 ms (0 over 40 ms).
4. **Large synchronous parses** on the voice thread. The 54 MB D&D compendium silenced audio for
   3.3–8.8 s on first use; a library-wide JSON parse caused 211–432 ms gaps, an xml2js parse
   367–566 ms.
5. **Two bot copies with the same token** for about five hours, fighting over the voice session.
   The single-instance lock fixes it once the running copy restarts onto it.

Also measured, not acted on: the upload is about 126 kbps (96k VBR Opus, no in-band FEC);
`NoSubscriberBehavior.Stop` turns any music reconnect into a cut track; Windows' 15.6 ms timer
granularity adds about ±11 ms of send jitter and caps catch-up at about 1.28x, because the voice
library sends one packet per cycle (64–69 packets/s while catching up), not missed packets back to
back.

The user-side fix with the most evidence behind it is **Ethernet instead of Wi-Fi**. In code, two
things shipped. The others are still open: replacing `Readable.from` with `Readable.fromWeb` (WP0
in the audiobook plan, which has to keep a paused song from holding a stalled Plex socket), Opus
bitrate profiles, moving the big parses off the main thread, and Pause instead of Stop for music.

### Process priority (`helpers/processPriority.js`)

`os.setPriority(0, …)` to `PRIORITY_ABOVE_NORMAL` by default, or `PRIORITY_NORMAL` when
`processPriority` is `normal`. Applied in `start()` before the login, and again whenever `/config`
changes the setting; the effective priority is read back and logged as `Process priority: <name>`.

- Only this process is raised. Windows starts a child of an Above Normal parent at Normal (only
  Idle and Below Normal are inherited), so ffmpeg keeps competing on equal terms with everything
  else instead of with the voice timer.
- Linux and Docker refuse a raise without `CAP_SYS_NICE`. That answer cannot change while the
  process lives, so it warns once (`Could not set process priority to above_normal (…); the bot
  runs at the priority it was started with.`), including across `!restart` and later config
  changes, and never throws.
- Pick `normal` if a game running beside the bot suffers.

### The voice-health log (`helpers/voiceHealth.js`)

Off by default (`voiceHealthEnabled`). **While off, every hook returns on its first line: no
listeners, no timers, no writes.** While on it cost 0.063% of wall time in a smoke run, and a
10-run A/B against the real `AudioPlayer` could not tell it apart from contention noise. It applies
at once from `/config`; turned on mid-track, it adopts the connections and players already
playing.

What it hooks:

- `Bot.openConnection()` calls `watchConnection(conn)`. The sampler wraps that connection's
  `dispatchAudio` as an own property, so it sees every packet without touching the voice library's
  prototype or any other connection. It also follows the connection's and its networking's state
  changes, and the voice WebSocket's close codes.
- `runPlayback` calls `watchPlayer(player, { kind: 'music' })` after creating each music player,
  and the book engine `watchPlayer(player, { kind: 'book' })` for each session. The book engine
  also records `book-early-end` events.
- A one-second tick samples players and connections, and measures its own drift as a stall.

What it records, per minute that had any voice activity (idle minutes stay in memory for the
command and cost no disk):

| Field | Meaning |
| ----- | ------- |
| `pkts`, `gaps` (40/60/100/200/500 ms), `maxGap`, `burst` | packets sent and the gaps between them; `burst` counts the back-to-back catch-up sends |
| `underMs` | source starvation: the player's `playbackDuration` advanced and the resource's did not. Counted only while `silenceRemaining` is −1, so the five padding frames after a stream ends are not starvation. |
| `ping` | `conn.ping.ws`, one reading per heartbeat. `ping.udp` is never assigned in `@discordjs/voice` 0.19. |
| `drops` | a connection leaving Ready |
| `el`, `elu`, `stallMax` | event-loop delay p50/p99/max (10 ms resolution, the coarsest that still sees one missed 20 ms send), utilisation, and the worst tick drift |
| `cpu`, `sys`, `rssMB`, `heapMB`, `gc` | this process's CPU, the machine's, memory, and GC pauses |

Events: `gap` (≥ 40 ms), `stall` (≥ 100 ms), `gc` (≥ 50 ms), `underrun` (≥ 100 ms), `conn`, `net`,
`ws-close`, `player` (to and from AutoPaused), `track` (one line per music track or book part),
`mark` and `book-early-end`. At most 120 events per minute are kept; `mark`, `conn`, `net`,
`ws-close` and `book-early-end` are never dropped, because a complaint is read against them. Memory
holds the last 120 minutes and 500 events.

Written to `data/logs/voice-YYYY-MM-DD.jsonl` with one async append per minute, pruned by the same
`PLEXBOT_LOG_RETENTION_DAYS` rule as the other day-files. Under the test runner it writes only
when `PLEXBOT_LOG_DIR` is set, the same rule as the command log.

**Two things it must never do.** Enable the voice library's `debug` option: its WebSocket debug
lines carry the session token. And listen for `'error'` on a `VoiceConnection`: with no listener a
voice error reaches the global `uncaughtException` handler in `app/utils.js`, and adding one would
swallow it.

**`!voicehealth`** (`commands/voicehealth.js`, `helpers/voiceHealthFormat.js`):

- `!voicehealth [minutes]` (1–120, default 15) shows one row per active minute in the host's
  clock, then the last 10 events and a legend. Flags: `G` a gap of 100 ms or more, `U` the source
  starved for 100 ms or more, `N` voice dropped, `L` event-loop p99 of 50 ms or more, `C` machine
  CPU at 90% or more. The current minute is marked `*`. It fits one 2,000-character message by
  dropping the oldest minutes first, then the oldest events.
- `!voicehealth mark <what you heard>` stamps the timeline at that moment and replies with the
  last 2 minutes. Run it right after a stutter, so the minute can be read against send gaps, CPU
  and reconnects.
- While the log is off, both answer with how to turn it on.

## Testing

`npm test` runs Node's built-in test runner (`node --test test/*.test.js`): 1,173 tests in 80 files on 2026-10-09, all passing, in about 25 s. They don't make network calls. Tests will fail if `config/keys.js` or `config/plex.js` are missing; copy them from the `.example.js` files first.

Every test that touches a store or a log points it at a pid-suffixed `os.tmpdir()` path through its env var (`PLEXBOT_LOG_DIR`, `PLEXBOT_BOOK_CATALOG_FILE` and the rest) before the first require, and never writes `data/`. `test/bookResourceFfmpeg.test.js` runs the real ffmpeg-static through the real proxy on a generated 20 s WAV (about 1 s); the engine tests run a real `AudioPlayer` on injected Opus-silence resources, so they inject timers rather than mocking the global ones, which would freeze the player's 20 ms cycle.

---

## Quirks worth knowing

- **`commands/playlist.js/` is a directory** with `.js` in its name, not a file. The auto-loader's regex (`/\.js$/`) matches the directory name, and Node resolves the `require()` to `commands/playlist.js/index.js`. Clever but surprising; rename later if it becomes confusing. `commands/book.js/` does the same, and its `index.js` requires its four subcommand files by name, so a stray file dropped in that directory never becomes a command.
- **The `Bot` class instantiates its own `PlexAPI`** in `app/bot.js`, separate from `helpers/plexClient.js`'s shared instance. Two TCP connection pools to the same Plex server. Legacy from before the helper existed; could be unified later.
- **`iceName` was a typo** in the Bot class's PlexAPI options — fixed in this iteration to `deviceName`. The Bot now identifies itself correctly to Plex.
- **`!youtube` works in two modes**: a URL plays directly; anything else hits `@distube/ytsr` for search and plays the top video result.
- **A download's `'finish'` or `'end'` must not end a track.** Until October 2026 YouTube tracks were cut short: at the shipped `youtube_quality` of `lowestaudio`, a 60 s video was dropped before it played and a 3:30 one stopped after 47.7 s. `runPlayback` ended a track on its download's `'finish'` as well as on the player going Idle. ytdl's stream emits `'finish'` once the whole file has been written into it, with 0.9–1.15 MB of audio still buffered ahead of the player, about 2.5 minutes at `lowestaudio`. `'end'` is early too: on a real player with a 120 s track, `'finish'` came at 0.2 s, `'end'` at 89 s and Idle at 120 s. A Plex download never emits `'finish'`. Covered by `test/playbackDownloadEnd.test.js`.
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

Every log line goes through `helpers/logger.js`. Format:

```
[2026-05-16T10:44:27.633Z] INFO  Bot ready — logged in as ...
```

Levels: `debug`, `info`, `warn`, `error`. Set `LOG_LEVEL=debug` to surface the verbose Gemini debug output and other internal traces. Default is `info`.

Errors caught by the global `uncaughtException` / `unhandledRejection` handlers (`app/utils.js`) print at `ERROR` level but **do not exit the process**, because the bot is meant to survive transient async errors.

Two sinks, both under `data/logs/`, both kept indefinitely. A third, the voice-health log (`voice-<date>.jsonl`), is written only while `voiceHealthEnabled` is on; see "Voice health and process priority".

Set `PLEXBOT_LOG_RETENTION_DAYS` to a positive number to delete day-files older than that; unset, 0 or unparseable keeps everything, which is the default. One variable covers both sinks and the voice-health log.

Retention and the read window are separate. Readers default to the most recent 14 day-files (`commandLog.DEFAULT_READ_DAYS`), because reading every day since install would only get slower as the pile grows. `npm run logs -- --days=60` widens it, `--all` reads the lot, and a `--since` longer than the default widens it on its own.

Everything else that reads is windowed, so every reader **says so** whenever there are more day-files on disk than it read. `commandLog.windowInfo()` answers that without reading any of them, and shares `windowFor()` with `readInvocations` so the note cannot describe a window nobody used. This was `--stats`-only at first, and the gap was not cosmetic: a search whose match fell outside the window answered `No invocations logged yet.` with a year of files sitting in `data/logs/`.

**`helpers/logger.js`** mirrors console output to `bot-YYYY-MM-DD.log`. Console-only logging meant
any failure nobody was watching scrolled past unrecoverably.

**`helpers/commandLog.js`** records structured JSON Lines: `invoke` (path, command, args, user,
channel), `outcome` (ok, ms, error stack) and `output` (what the bot posted). One object per line,
so a process killed mid-append costs one event rather than the file.

The audiobook suite adds three event types to the command log: `music-gated-by-book` (a music
request queued behind a book, with the guild, work and queue length), `book-stream-error` (ffmpeg
failed to spawn or its stream errored) and `book-save-failed` (a bookmark write failed; recorded
once per failure streak, with `Audiobook bookmarks are being saved again.` in the bot log on
recovery).

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
| Audiobooks and podcasts          | `commands/book.js/`, the card's `book:*` buttons | `helpers/bookEngine.js` (player), `bookModel.js`, `bookmarks.js`, `bookCard.js`, `bookButtons.js` |
| Audiobook catalog                | `helpers/bookLibrary.js` (Plex), `/book rescan` | `helpers/bookCatalog.js`, `bookCatalogStore.js`; `data/book_overrides.json` |
| Book audio from Plex             | `helpers/bookResource.js`            | `helpers/partProxy.js`, `bookAudio.js`, ffmpeg-static         |
| Books kept out of music          | every music picker, search and Hitster | `helpers/longForm.js`; the Plex fragment in `plexTags.js` and `commands/list.js` |
| Music and books sharing voice    | `app/bot.js` `runPlayback` gate, `musicBusy()` | `helpers/voiceClaims.js`, `bookEngine.blocksMusic` / `routeGeneric` |
| Voice-health log                 | `commands/voicehealth.js`            | `helpers/voiceHealth.js`, `voiceHealthFormat.js`; hooks in `app/bot.js` and `bookEngine.js` |
| Process priority                 | `app/utils.js` `start()`             | `helpers/processPriority.js`                                |
