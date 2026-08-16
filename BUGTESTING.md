# Bug-testing checklist

Practical pass for this bot. Phase 0 is the `/play` symptom specifically; Phases 1–6 are the
repeatable sweep to run after any change that touches dispatch, commands, or deps.

Run the bot with output captured — the logger writes to console only, nothing is persisted:

```bash
node index.js 2>&1 | tee data/bot-session.log
```

---

## Phase 0 — Triage: `/play` fails, `!play` works

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
node scripts/validate-slash.js .
```

(script currently lives in the scratchpad — say the word and I'll drop it in the repo as
`npm run check:slash`)

It checks the rules Discord rejects on: lowercase names matching `^[\w-]{1,32}$`, 1–100 char
descriptions, ≤25 options/choices, no subcommands mixed with top-level options, and
**required options declared before optional ones**. All 52 specs pass today.

- [ ] New/edited `slash:` block → re-run the validator.
- [ ] Renamed or deleted a command → confirm the stale one disappeared from the picker (the `set()`
      call replaces the whole list, so it should).

## Known broken today (verified by reading the running code — no need to re-derive)

`/play` is fine. These six are not. Two root causes.

**Cause 1 — the adapter's `content` isn't prefix-shaped.** The facade sets
`content = query` ([helpers/interactionAdapter.js:95](helpers/interactionAdapter.js#L95)), but three
commands parse args as `msg.content.split(' ').slice(1)` — which assumes `content` starts with the
`!command` token. Under slash, `slice(1)` eats the real argument instead:

- [ ] `/game title:<x>` → answers *"⚠️ Please provide a game to search for!"*
      ([commands/game.js:37](commands/game.js#L37))
- [ ] `/launch title:<x>` → answers *"⚠️ Please provide a game to launch!"*
      ([commands/launch.js:45](commands/launch.js#L45))
- [ ] `/profile mode:regen` → **silently ignores** the mode and shows the existing sheet
      ([commands/profile.js:37](commands/profile.js#L37))

One-line systemic fix, in the adapter rather than in three commands:
`content: config.commandPrefix + interaction.commandName + (query ? ' ' + query : '')`.
No command reads `content` expecting the bare form, so this is safe and inoculates future commands.

**Cause 2 — slash spec doesn't match what the command parses.**

- [ ] `/song query:<x>` — the option is **required and completely ignored**; the command just prints
      the now-playing card (`!song` takes no args). Fix: drop the option
      ([commands/song.js:18](commands/song.js#L18)).
- [ ] `/survive` — spec declares no options, but the parser needs `start [difficulty]`, so an empty
      query always lands on the menu branch. **No way to start a game via slash.** Fix: a `start`
      subcommand with a `difficulty` choices option — `buildQueryString` prepends the subcommand
      name, so that yields exactly `start nightmare`
      ([commands/survive.js:43](commands/survive.js#L43)).
- [ ] `/releasesurvival game` — the parser wants `start <category>`, so `game` hits
      *"⚠️ Unknown command"* every time. Fix: rename the subcommand to `start` and add a required
      `category` choice (movies/shows/albums) ([commands/releasesurvival.js:140](commands/releasesurvival.js#L140)).
      `/releasesurvival leaderboard` works.

**Watch, not confirmed broken:** `/sonic` re-dispatches by mutating `msg.content` and re-emitting a
synthetic `messageCreate` with the adapter object
([commands/sonic.js:238](commands/sonic.js#L238)). It should work, but it also collects on the
channel expecting to see the bot's own reply — and under slash the first reply is an interaction
response. Test it end to end before trusting it.

**Cleared (don't chase these):** `.has('ADMINISTRATOR')` in
[commands/hitster.js:185](commands/hitster.js#L185) — v14 still accepts the legacy uppercase name,
verified. The `...args` sniffing pattern used by the game commands correctly finds the adapter.

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
- **Logs are console-only.** Nothing is written to disk, so a failure that happened yesterday is
  unrecoverable. Pipe to a file while bug-testing (command at the top).
- **2 of 79 unit tests fail on your machine** (`test/plexHome.test.js`) — they assert on a missing
  `homeOwnerToken` but read your real `config/plex.js`, where it's set. It's a test-isolation bug,
  not a bot bug, but it means `npm test` isn't currently a clean signal.
