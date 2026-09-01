# Bug-testing checklist

Practical pass for this bot. Phase 0 is the `/play` symptom specifically; Phases 1–6 are the
repeatable sweep to run after any change that touches dispatch, commands, or deps.

The bot now persists its own logs to `data/logs/`, so a failure you didn't happen to be watching
is still there afterwards:

```bash
npm run logs -- --errors
```

That prints each failed command with its arguments, who ran it, and the stack. `npm run logs`
alone shows recent commands paired with what the bot replied.

---

## Phase 0 — Triage: a slash command fails but its `!` version works

The two paths share `plexCommands` and the same `process()` function
([app/music.js:37](app/music.js#L37) prefix, [app/music.js:72](app/music.js#L72) slash), so a
symptom that hits *only* the slash side is almost always registration or authorization, not the
command. Answer Q1 first — it splits the tree.

**Q1. Does `/play` appear in Discord's command picker when you type `/`?**

### It does NOT appear → registration/authorization

- [ ] **Restart the bot and read the boot lines.** Registration only runs on `clientReady`
      ([app/music.js:16](app/music.js#L16)). You want to see
      `Registered 52 slash commands in guild 396106436326981642 (instant).`
      Anything starting `Failed to register slash commands` is the answer — the error text names
      the cause (403 Missing Access, 401, invalid form body).
- [ ] **Confirm the bot was invited with the `applications.commands` scope.** This is the #1
      suspect for a bot that started life prefix-only: an invite with just the `bot` scope logs in
      fine, receives messages fine, and gets **403 Missing Access** on
      `guild.commands.set()`. Fix = re-invite with both scopes (no kick needed, it re-authorizes in
      place):
      `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=<perms>`
- [ ] **Confirm you're testing in the right server.** In the copy you actually run (the
      `experimental` checkout in the project root) `testGuildId` is `396106436326981642`, so
      commands register in **that guild only**. They will not appear in any other server, and
      guild-scoped commands never appear in DMs. Prefix commands work everywhere — which
      reproduces this exact symptom. Note this branch's [config/config.js](config/config.js) has
      `testGuildId` blank, i.e. global registration with up-to-an-hour propagation.
- [ ] **Ask Discord what it actually has registered** (read-only, uses the local token):

```bash
node -e "const k=require('./config/keys.js'),c=require('./config/config.js');const h={Authorization:'Bot '+k.botToken};fetch('https://discord.com/api/v10/applications/@me',{headers:h}).then(r=>r.json()).then(async a=>{for(const u of [['guild',`/applications/${a.id}/guilds/${c.testGuildId}/commands`],['global',`/applications/${a.id}/commands`]]){const r=await fetch('https://discord.com/api/v10'+u[1],{headers:h});const j=await r.json();console.log(u[0],r.status,Array.isArray(j)?j.map(x=>x.name).join(' '):JSON.stringify(j));}})"
```

- [ ] **Restart your Discord client** (Ctrl+R). The picker caches; a freshly registered command
      sometimes needs a reload to show up.
- [ ] If you booted a checkout with `testGuildId` blank, registration is **global** — up to an
      hour to propagate, and it does not remove commands previously registered guild-scoped.

### It DOES appear but errors → runtime

- [ ] `"This interaction failed"` immediately → the defer failed. Look for
      `Failed to defer interaction for /play` in the log.
- [ ] `"❌ Command failed — check the bot log"` → `process()` threw; the stack is in the log
      ([app/music.js:126](app/music.js#L126)).
- [ ] Stuck on *"Bot is thinking…"* forever → the command never produced output. Every code path
      must reach a `reply()`/`channel.send()`; the first one becomes `editReply`
      ([helpers/interactionAdapter.js:25](helpers/interactionAdapter.js#L25)).
- [ ] `/play` with no `song:` value and an empty queue is *expected* to answer `PLAY_FAIL` — make
      sure you're not reading correct behavior as a failure.
- [ ] Not in a voice channel → `playSong` needs `message.member.voice.channel`
      ([app/bot.js:414](app/bot.js#L414)).

---

## Phase 1 — Boot

- [ ] `Loaded 52 commands (2 aliases)` — any `Failed to load N command file(s)` line means a
      command file is broken and **silently unavailable on both paths**.
- [ ] `Registered N slash commands …` — N should equal the number of slash-declaring commands
      (52 today; aliases `?` and `plextest` are correctly excluded).
- [ ] Health monitor / event server / presence / theater lines appear as expected for the
      toggles in config.
- [ ] No `Uncaught exception` / `Unhandled promise rejection` in the first 30s.

## Phase 2 — Slash registration integrity

`client.application.commands.set()` / `guild.commands.set()` is **all-or-nothing**: one malformed
spec anywhere means *zero* commands register and every `/x` disappears at once. Validate offline
before booting whenever you add or edit a `slash:` block:

```bash
npm run check:slash
```

It checks the rules Discord rejects on: lowercase names matching `^[\w-]{1,32}$`, 1–100 char
descriptions, ≤25 options/choices, no subcommands mixed with top-level options, and
**required options declared before optional ones**. It also warns when a command bails out
without an argument but declares no option to supply one — the bug that shipped twice. All 53
specs pass today.

- [ ] New/edited `slash:` block → re-run the validator.
- [ ] Renamed or deleted a command → confirm the stale one disappeared from the picker (the `set()`
      call replaces the whole list, so it should).

## Fixed — regression checks

These all shipped broken and are now fixed. They are worth re-running after any change to the
slash plumbing, because each one was invisible from the prefix side.

**Arguments reaching the command.** The adapter used to set `content` to the bare argument
string, but several commands parse args as `content.split(' ').slice(1)` — so the first
argument was eaten. `content` is now prefix-shaped (`!name args`).

- [ ] `/game title:<x>` returns metadata (used to answer "please provide a game to search for")
- [ ] `/launch title:<x>` finds the game
- [ ] `/profile mode:regen` actually regenerates (used to silently ignore the mode)

**Spec matching the parser.** A slash spec has to line up with what `process` reads, in both
directions — a declared option nothing consumes is as broken as required input never declared.

- [ ] `/song` takes no argument and shows the current track (once demanded a `query` it ignored)
- [ ] `/vibe vibe:<x>` runs (once had no field to type into at all)
- [ ] `/sonic target:<x>` runs (same bug)
- [ ] `/survive start difficulty:nightmare` starts a game (once could only print the menu)
- [ ] `/releasesurvival start category:movies` starts a run (`game` never matched its parser)

`npm run check:slash` catches this class before boot — run it after editing any `slash` block.

**Error reporting that told the truth.** `game`/`launch` used to answer "Search timed out" for
any failure, logging nothing, so a real error was indistinguishable from a timeout.

- [ ] A genuine timeout still says timed out; a real failure names itself and hits the log

**`/vibe` crash.** `rawInputLower` was used in the scoring pass and never defined, so every run
that got that far threw. Both `!vibe` and `/vibe` were affected.

- [ ] `/vibe vibe:"1 hour of cyberpunk nightclub"` completes and queues music

## Tag review and rotation

- [ ] After a `/vibe` run, the review card appears for tracks Plex has no metadata for
- [ ] **Approve** writes only that track — check `/tags list`
- [ ] **Reject** writes nothing and moves on
- [ ] **Tell it why & retry** opens the box, and the suggestion changes to match what you said
- [ ] A restart mid-review keeps both the approved tracks and the remaining card
- [ ] Clicking as a different user is refused
- [ ] `/tags coverage` reports plausible percentages against the library size
- [ ] `/tags export` writes a file with track file paths in it
- [ ] `/tags discovery percent:0` stops wildcards appearing; a non-zero value keeps queue size
      the same (wildcards replace curated picks rather than adding to them)

## Phase 3 — Prefix ↔ slash parity

For each command you touch, run it **both ways** and compare. The slash path flattens options into
the same space-separated `query` string the prefix parser produces
([helpers/slashRegistry.js:142](helpers/slashRegistry.js#L142)), so mismatches show up as wrong
args rather than crashes.

- [ ] `!play beatles` vs `/play song:beatles`
- [ ] `!playlist play mix -r` vs `/playlist play name:mix shuffle:True` — the boolean emits the
      literal `-r` token via `flag`; if a new boolean option forgets `flag:`, the parser receives
      the string `"true"`.
- [ ] `!volume 50` vs `/volume level:50`, `!playsong 3` vs `/playsong number:3` — INTEGER options
      stringify.
- [ ] `!mysheet @user` vs `/mysheet user:@user` — mentions come from the USER option via the
      adapter's `mentions.users.first()` shim
      ([helpers/interactionAdapter.js:52](helpers/interactionAdapter.js#L52)), not from message text.
- [ ] Subcommand commands (`/playlist`, `/library`, `/list`, `/request`, all the game ones):
      the subcommand name is prepended to `query`, so `!request complete 4` ≡
      `/request complete id:4`.
- [ ] Autocomplete-backed options (`/playlist print|remove|add|delete|play`) populate; an
      undeclared handler silently returns an empty list ([app/music.js:75](app/music.js#L75)).

## Phase 4 — Interaction-lifecycle traps (slash only)

- [ ] **First output ≠ later output.** The first `reply()`/`channel.send()` becomes `editReply`,
      everything after is a normal channel message. Commands that edit their own status message
      later should be checked once via slash.
- [ ] **15-minute token.** If a command's *first* output comes more than ~15 min after invocation,
      `editReply` fails. Relevant to the long game flows (`/trivia`, `/hitster`, `/groupwatch`,
      `/survive`, `/quotethebard`).
- [ ] **Collector flows.** Games collect on `interaction.channel` — verify the collector still sees
      replies when the game was started with `/` instead of `!`.
- [ ] **DM flows.** `/request add`, `/playlist plex-list`, `/playlist plex-copy` open a DM and await
      messages there. Test with DMs closed too — `createDM()` rejects and should surface an error,
      not a silent hang.
- [ ] **Ephemeral commands** (`/config`) answer privately and stay private.

## Phase 5 — Playback (the part that breaks quietly)

- [ ] Queue one track, let it finish → bot advances, then disconnects.
- [ ] Queue several, `!skip` mid-track, `!pause`/`!resume`, `!stop` while idle (`stop()` touches
      `this.conn`/`this.dispatcher` with no null guard — [app/bot.js:405](app/bot.js#L405)).
- [ ] Start playback from two different channels/users back to back (`workingTask` semaphore).
- [ ] A track that 404s on Plex → `⚠️ Playback failed … Skipping.` and the queue advances.
- [ ] `!play` a YouTube URL (ytdl path) as well as a Plex track.

## Phase 6 — Integrations

- [ ] `/diag` — one call covers Plex, Gemini, Tautulli, Playnite connectivity.
- [ ] Plex Home account switching (`/playlist plex-list account:…`).
- [ ] Tautulli-backed `/stats`, Playnite-backed `/launch`, `/pickgame`.

---

## Environment landmines found while reading

- **`package-lock.json` is badly stale and would break a fresh install.** It pins
  `discord.js@13.12.0` while `package.json` asks for `^14.16.0` and `14.26.4` is what's installed.
  `npm ci`, a Docker build, or a fresh clone would install v13 — where the `clientReady` event
  doesn't exist, so slash registration would never run at all, plus v13/v14 API breaks throughout.
  Worth regenerating (`rm package-lock.json && npm install`) — but see the next item first.
- **`xml2js` installed is 0.4.16 while `package.json` says `^0.6.2`.** The Plex code depends on the
  0.4.x callback API, so regenerating the lockfile will bump it and can break Plex parsing. Pin
  `"xml2js": "0.4.16"` in `package.json` before regenerating, and re-test `/diag` after.
- ~~Logs are console-only.~~ Fixed: `data/logs/` now holds both a console mirror and a structured
  command log, kept indefinitely. Read it with `npm run logs`.
- **2 of 122 unit tests fail on your machine** (`test/plexHome.test.js`) — they assert on a missing
  `homeOwnerToken` but read your real `config/plex.js`, where it's set. It's a test-isolation bug,
  not a bot bug, but it means `npm test` isn't currently a clean signal.
