# Bug-testing checklist

Practical pass for this bot. Phase 0 is the `/play` symptom specifically; Phases 1–6 are the
repeatable sweep to run after any change that touches dispatch, commands, or deps. Phases 7, 8
and 9 are the first live pass of the audiobook suite, of the voice-health log and process
priority, and of the audiobook read-along, none of which has met a real voice channel yet.
Phase 10 is the first live pass of the catalog's rules version 3: embedded tags, book metadata,
`!book edit`, the optional online lookup and the card's chapter words.

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
      `Registered 56 slash commands in guild 396106436326981642 (instant).`
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

- [ ] `Process priority: above_normal` (or `normal`, if that is what `/config` → Voice says). On
      Linux or Docker without `CAP_SYS_NICE` there is one `Could not set process priority` warning
      instead, and the bot carries on.
- [ ] `Loaded 56 commands (4 aliases)`: any `Failed to load N command file(s)` line means a
      command file is broken and **silently unavailable on both paths**.
- [ ] `Registered N slash commands …`: N should equal the number of slash-declaring commands
      (56 on 2026-10-09; the aliases `?`, `plextest`, `archipelago` and `books` are correctly
      excluded).
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
without an argument but declares no option to supply one, the bug that shipped twice. Since the
audiobook suite it also checks that every choice value matches its option's type (a number on a
STRING option takes down the whole registration), choice names of 1–100 characters, choices and
autocomplete only on STRING, INTEGER or NUMBER, and Discord's 4,000-character budget per command.
All 56 specs passed on 2026-10-10, the largest `/ap` at 2,783 characters and `/book` at 1,833
(20 subcommands, with `text` and `link`).

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
- [ ] **Ephemeral commands** (`/config`) answer privately and stay private. `/book` is private
      for every subcommand except `/book leaderboard`, including its second and later replies (a
      "Which one?" list, a chapter list), which go out as private follow-ups rather than channel
      posts.

## Phase 5 — Playback (the part that breaks quietly)

- [ ] Queue one track, let it finish → bot advances, then disconnects.
- [ ] Queue several, `!skip` mid-track, `!pause`/`!resume`, `!stop` while idle (`stop()` touches
      `this.conn`/`this.dispatcher` with no null guard — [app/bot.js:405](app/bot.js#L405)).
- [ ] `!pause`, `!resume`, then click the now-playing card's Pause/Resume button: it pauses, and a
      second click resumes. The next track's card reads Pause. A second `!resume` replies "Nothing
      to be resume."
- [ ] Start playback from two different channels/users back to back (`workingTask` semaphore).
- [ ] A track that 404s on Plex → `⚠️ Playback failed … Skipping.` and the queue advances.
- [ ] `!youtube` a URL (ytdl path) as well as `!play` a Plex track. Queue two videos with
      `!youtube` and let the first play to its last second: the second is announced only then.

## Phase 6 — Integrations

- [ ] `/diag` — one call covers Plex, Gemini, Tautulli, Playnite connectivity.
- [ ] Plex Home account switching (`/playlist plex-list account:…`).
- [ ] Tautulli-backed `/stats`, Playnite-backed `/launch`, `/pickgame`.

## Phase 7: Audiobooks and podcasts (live)

Built and unit-tested offline (398 tests in 24 files, the filters and guards mutation-checked),
never yet run against a live voice channel and a live Plex. Everything below is what the tests
cannot reach. Watch `npm run logs -- --raw` for `music-gated-by-book`, `book-stream-error` and
`book-save-failed` while you go.

**Turning it on**

- [ ] Before enabling: `/book play` and every other subcommand answer "📚 Audiobooks are turned
      off…", the help embed has no AUDIOBOOKS line, and nothing about music has changed.
- [ ] `/config` → Audiobooks → enable. No restart. The first `/book play` says "Reading the
      library (about 20 s)"; a minute later `/book library` lists the books and podcasts. The help
      embed now has the AUDIOBOOKS line.
- [ ] `/book rescan` as the owner reports works, parts, hours, any low-confidence part orders and
      the long folders left as music. As anyone else it is refused. During a Plex library scan it
      says Plex is scanning.
- [ ] Put a deliberate JSON typo in `data/book_overrides.json`, `/book rescan`: the reply names the
      error and the catalog is unchanged. Fix it, rescan: the override applies.

**Playing**

- [ ] Resume 5 h into a single-file m4b that has embedded chapters: audio within about 2 s.
- [ ] Note the time to first audio at the start, an hour in and five hours in. `-analyzeduration
      0` sits after `-i`, so ffmpeg still runs its default 5 s input analysis; if resumes feel slow,
      this is the number to bring back.
- [ ] ±30 s across a part boundary lands in the previous or next file at the right spot.
- [ ] `/book chapter` autocomplete is centred on the current chapter; jump to chapter 4 of 6 inside
      that m4b.
- [ ] `/book goto 1:23:45`, `+5m`, `-90` all land; `/book goto 1:75` is refused.
- [ ] 1.5x, then back to 1x: pitch is normal at both, and `/book shelf` shows the right %.
- [ ] `/book sleep` 5 min: stops after 5 minutes of listening, not counting a pause in between.
- [ ] `/book sleep` end of chapter, including the **last** chapter of a chaptered m4b: it stops
      there and does not run on into the next file.
- [ ] A work with 300 or more part files plays from one file into the next with only card edits:
      no voice rejoin, no new message.
- [ ] The card still edits after 15+ minutes (it is a channel message, not an interaction reply).
- [ ] Rapid ±30 s clicks: one stream, ending where the clicks add up to.

**Voice and presence**

- [ ] Leave voice: the card says you left and shows Resume; rejoining does not resume on its own.
      After `audiobookIdleLeaveMinutes` (10) the bot leaves.
- [ ] Disconnect the bot from voice: the card ends with "🔌 Lost the voice connection", and
      `/book play` resumes from the saved place.
- [ ] Move the bot to another channel: it either carries on there or ends the same way with the
      place saved. Note which. Silence with a live card is the failure.
- [ ] `/book stop` while the bot is still joining, then `/book play` again: it starts, and the
      bookmark did not move.
- [ ] `/book play` from phone and desktop at once: one session; the second gets "Still joining the
      voice channel, one moment."

**Music and books in one server**

- [ ] `!play <song>` during a book: one short reply each time ("📚 Queued behind …'s book (N
      waiting)."), the long explanation at most once per 30 s. `/book stop` then starts the queued
      music.
- [ ] `/play song:<x>` during a book: the "thinking…" closes with the queued line.
- [ ] Sleep timer, leaving voice, or the book finishing with music queued: the music does **not**
      start on its own.
- [ ] `!stop` on music, then `/book play` straight away: accepted.
- [ ] `/book play` while music is playing: "Music is playing here. Stop it with !stop, then /book
      play."
- [ ] `!hitster` create and start during a book: refused, naming the listener. `/book play`
      during a Hitster game: refused.
- [ ] `!pause`, `!resume`, `!skip 3` (moves **one** chapter) and `!stop` during a book act on the
      book. `!stop` also clears the music queue and does not start it. Someone not allowed to
      control the book gets the music command as before.
- [ ] The old now-playing card's Pause/Resume on a parked book resumes it.
- [ ] Someone else clicking the card's controls gets the private "This is …'s book" refusal; the
      owner, and someone in the channel after the listener left, can pause and stop.
- [ ] Clicking a card from an earlier session strips its buttons and says so privately.

**Bookmarks and finishing**

- [ ] `!restart` mid-book: the place is saved. `scripts/stop-bot.ps1` mid-book, start, resume: at
      most 15 s lost.
- [ ] Resume the next day: it rewinds 30 s (10 s after more than 5 minutes away).
- [ ] Re-scan the library in Plex, then resume: it plays (the part key is repaired), from the right
      place.
- [ ] Stop within the last 2 minutes of a book: not finished; the ended card offers ✅ Mark
      finished. Only the listener can press it; pressing it marks it finished once.
- [ ] Catch up on a podcast, add an episode in Plex, wait for the hourly check or `/book rescan`,
      `/book play`: it starts on the new episode ("▶ 1 new episode since you caught up").
- [ ] `/book play` on a finished book: "You finished this on …, starting again."
- [ ] `/book forget` asks first (a button on `/`, `!book forget <id> confirm` on `!`).
- [ ] `data/book_bookmarks.json` exists after a play, and `data/book_bookmarks.json.bak` appears
      within the hour.
- [ ] `/book leaderboard` is public; `/book stats`, `/book shelf` and the rest are private.

**Books kept out of music**

- [ ] The Plex-side filter syntax (`album.id!=…&artist.id!=…`) was taken from probes before the
      build and has not been re-checked since. `!list` browse shows no chapters, and the Hitster
      pool shrinks by the number of dated book parts. If either is wrong, every Plex-side count
      and sample is wrong too.
- [ ] `/vibe`, `/sonic` and `!random` never return a chapter over several runs.
- [ ] `/vibe <a book author>`: nothing queued, a "📚 Also in your books" line.
- [ ] `/sonic songs like <a book title>`: the redirect line, no anchor track.
- [ ] `!quotethebard start easy playlist <a playlist of only books>`: refused.
- [ ] `!play <a book title>`: music hits as before plus the redirect line; a page of only books
      says "Those are audiobook chapters, not songs." `!album` and `!artist` for a book behave the
      same.
- [ ] `!playlist add` of a book chapter is refused with the redirect.
- [ ] A smart Plex playlist that contains books: "📚 Skipped N audiobook tracks in this smart
      playlist." A regular playlist with a book in it still plays it.
- [ ] `/curate` asking for audiobooks or a book author in Music: no chapter files recommended.
- [ ] `!groupwatch` with target Music, and `!quest` in the Music realm: no chapters.
- [ ] `!identify`, answer Yes (vault), describe a long book you own: one suspect for the book, no
      "Whoa there … possible suspects". (It still says "Grab the popcorn", which reads oddly for a
      book; that wording is unchanged.)
- [ ] `!identify`, answer No (global), naming an audiobook author: still "Good news! … in the
      vault".
- [ ] `!releasesurvival start albums` over several rounds: no audiobook or podcast albums.
- [ ] `/tags coverage`: the track total drops by about the number of catalogued book tracks.
- [ ] Turn `audiobooksEnabled` off: books stay out of music. Turn `audiobooksExcludeFromMusic`
      off: they come back. Turn both back on.

## Phase 8: Voice health and process priority (live)

- [ ] During a track, Task Manager → Details shows `node.exe` at Above normal and its `ffmpeg.exe`
      at Normal.
- [ ] `/config` → Voice → Bot process priority → Normal: the log says `Process priority: normal`
      at once, no restart, and Task Manager agrees. Set it back.
- [ ] `!voicehealth` while the log is off: it explains how to turn it on.
- [ ] `/config` → Voice → Voice health log → on: the log says `Voice health log on`, no restart.
      Turned on mid-track, rows appear within a minute (it adopts the playing connection).
- [ ] `!voicehealth` during music: one row per minute with packets near 3,000, idle minutes
      hidden and counted in the title.
- [ ] `!voicehealth mark choppy for 2 s`: replies "**Marked.**" with the last 2 minutes, and the
      `mark` event is in the list.
- [ ] `!voicehealth 999` gives the usage line; `/voicehealth show minutes:5` and
      `/voicehealth mark` work.
- [ ] During a book: `track` events per part, and `book-early-end` events if Plex stalls.
- [ ] `data/logs/voice-<today>.jsonl` gains one `min` line per active minute and nothing while
      idle.
- [ ] `!voicehealth 120` after a long session still fits one message (oldest minutes dropped).
- [ ] Pull the network for a few seconds mid-track: the minute shows `N` and the events show
      `conn` or `net` changes.
- [ ] Turn the log off: `Voice health log off`, and the file stops growing.

## Phase 9: Read-along (live)

Built and unit-tested offline: 250 tests added, 1,462 of 1,462 passing on 2026-10-10. In those
tests Calibre is always a fake and every ebook is generated, so nothing below has been seen yet:
a real Calibre, a real EPUB, a DM page in a real client. Needs Phase 7's audiobooks on. Keep
`npm run logs -- --raw` and the bot log open while you go; neither may ever show a sentence of a
book.

**Before you start**

- [ ] The first start after this change rebuilds the book catalog once (the rules version went to
      2). `/book library` afterwards lists the same books as before.
- [ ] Calibre is open with its content server started: `http://127.0.0.1:8080` lists the library
      in a browser.
- [ ] `ownerId` is set (needed for `!book link`).

**The DM page**

- [ ] `!book play The Way of Kings`, then `!book text on`: "📩 Sent to your DMs." (or "Preparing
      the text in your DMs" the first time), and a DM page arrives. The first time, the bot log has
      `Read-along: read the ebook for cache <16 hex>: N sections, N words in N ms.`
- [ ] The page is in the chapter being narrated, and its footer reads "≈ Approximate ·
      dramatized edition · chapter-level · page N of M · following the narration".
- [ ] Let it play: the same message edits itself to the next page about once a minute at 1x.
      Note how far the page is from the voice, in words, at a few points.
- [ ] On a track not named after a chapter, the footer says "estimated from pace". Note how far
      off it is there.
- [ ] At 2x every page still appears, in order, about every 30 s. None is skipped.
- [ ] ±30 s: the page stays or steps one page. `/book chapter` to a far chapter: the page jumps
      there within about 2 s.
- [ ] ◀ and ▶ in the DM move the page, the footer says "browsing: 📍 Now follows again", and it
      stops turning. 📍 Now jumps back to the narration and follows again. (The DM click has no
      guild and no member; this is the path the tests could only fake.)
- [ ] ↪ Play from here on a page a few pages ahead: the audio jumps to that page's first words,
      and the page stays put until the narration passes it.
- [ ] Pause, then ↪ on another page: the book resumes from that page with no rewind.
- [ ] Pause: the footer says "⏸ paused" and nothing turns. Resume: it follows again.
- [ ] `!book text now`: a new page at the bottom of the DM; the old one says "📖 This page moved
      ↓". Clicking a button on the old one changes only that message.
- [ ] ✖ Off: the page says "📕 Read-along is off…", and `!book text` reports it off.
- [ ] `/book stop`: the page becomes "📕 `<title>`: the book stopped, so this page did too." with
      no buttons.
- [ ] The preference is remembered: `!book text on`, `/book stop`, `!restart`, then play another
      book that has an ebook. A new DM page opens by itself. After `!book text off`, it does not.
- [ ] Delete the DM page while the book plays: the log does not fill with errors, and the next
      `/book play` opens a new page.

**📖 on the card**

- [ ] A book with an ebook shows 📖 Text in the card's second row within a few seconds of
      starting. A book with none (a Dan Simmons) and a podcast never show it.
- [ ] As the listener, 📖: a private page, footer "only you can see this; 📍 Now shows the
      latest", with ◀ ▶ 📍 ↪ and 📩 Follow in DMs. On a book never read before, "⏳ Preparing the
      text" comes first, then the page.
- [ ] 📩 Follow in DMs turns the read-along on and opens the DM page.
- [ ] A second account in the book's voice channel clicks 📖: a private page at the same place
      as the listener's, with ◀ ▶ 📍 only (no ↪, no 📩). ◀ ▶ 📍 work for them, and the listener's
      book and DM page do not move.
- [ ] A second account in another voice channel, or in none, clicks 📖: a private "🔊 Join
      `<voice channel>` to read along." with no ping and no text.
- [ ] With that page open, the second account leaves the voice channel and presses ▶: the page
      turns into "🔊 Join `<voice channel>` to read along." with no buttons. Rejoin and press 📖
      on the card: a page again.
- [ ] The second account runs `!book text on`: "📖 Read-along is on. The next book you play opens
      a page in your DMs.", and no DM page of the listener's book opens for them. `!book text now`
      from them says they are not listening to a book. `!book text off` afterwards.
- [ ] 📖 on a card whose book has stopped: "That book is no longer playing."

**DMs closed**

- [ ] Turn off "Direct Messages" from server members for this server (Privacy Settings), then
      `!book text on`: "I can't DM you (your DMs are closed to this server). Use the 📖 button on
      the book card instead…". 📖 still works.
- [ ] With the read-along on and DMs still closed, start a book: exactly one line in the card's
      channel, "📖 `<name>`: I can't DM you the book's text. Open your DMs for this server, or use
      the 📖 button on the card.", with no ping and no book text. Pausing and resuming in the same
      session posts nothing more.

**Calibre closed**

- [ ] Close Calibre after The Way of Kings has been read once: the page keeps turning, and
      `!book text` says "(a cached copy: the source isn't answering)". After `!restart` and a new
      `/book play`, the page still opens.
- [ ] With Calibre closed, `!book text on` on a Calibre book never read before: "Calibre isn't
      answering. Open the Calibre app once…". Open Calibre and run `!book text on` again straight
      away: it works, with no 30 s wait.
- [ ] With Calibre closed, Words of Radiance's text still works (its EPUB is next to the audio).

**Sources and `!book link`**

- [ ] The Final Empire, with no link set: `!book text` works, and `!book link The Final Empire`
      shows Calibre #299 "Mistborn" ✅ (matched by series and book number).
- [ ] Words of Radiance: `!book text` says "text from EPUB next to the audio".
      `!book link Words of Radiance` lists the book's EPUB ✅ and the Pocket Companion with a low
      score and no ✅.
- [ ] `!book link "The Final Empire" 299`, then `id:299`, `isbn:9780765350381` and
      `isbn:0765350386`: each answers "🔗 Linked The Final Empire to Calibre #299 “Mistborn”
      (EPUB)."
- [ ] `!book link <a book> D:\…\file.epub` (a real local EPUB): the echo names the file name only.
      `!book link <a book> \\server\share\x.epub`: "Only a file on this PC's own drives can be
      linked."
- [ ] `!book link The Final Empire off`: `!book text` says it is switched off, and the next card
      has no 📖. `!book link The Final Empire auto` brings it back.
- [ ] `!book link The Final Empire` typed in a server channel: the public reply has no `D:\` or
      other full path and says the full details went to your DMs; the DM has them. The same
      command in a DM shows the full paths there.
- [ ] Someone who is not the owner: "⛔ Only the bot owner can link ebooks."

**Sync marks (📌)**

Built and unit-tested offline on 2026-10-11 (model, store, pager and command tests on synthetic
books), and checked on The Once and Future King's real map with one synthetic mark. No real click
has set one yet.

- [ ] The DM page has a second row with 📌 Narrator is here. The 📖 page has no 📌, for the
      listener or anyone else.
- [ ] On a page that is behind or ahead of the voice, page to the words being read and press 📌 as
      the narrator reaches the page's first words: the page shows that page, its footer says
      "marked · … · 📌 Marked at `<h:mm:ss>` · following the narration", and the time is about a
      second before your click. The next page turns in step with the voice.
- [ ] The confirmation shows once: pause, and the footer drops "📌 Marked at".
- [ ] On a book in hour splits, browse ▶ to a page several chapters ahead and press 📌: "📌 That
      page is too far from where the narrator is…", nothing stored, the page unchanged. Paused, 📌
      says marks need the book playing. A page in the next chapter is refused while a
      chapter-named track plays: near the end of a chapter track, ▶ to the next chapter's first
      page and press 📌: "📌 That page is outside the chapter now playing…", nothing stored.
- [ ] Press 📌 twice on the same page a few seconds apart: `!book marks` lists one mark.
- [ ] `!book marks`: each line has an audio time, the audio's chapter title, you, and the date, and
      no words of the book. `!book marks <title>` from someone not playing it shows the same list.
- [ ] `!book unmark` removes your latest; `!book unmark 2` removes the second if it is yours, and
      answers "⛔ Mark 2 is `<someone>`'s…" if it is not. `/book unmark which:1` works the same way.
- [ ] A non-owner's `!book unmark all` is refused. The owner's `!book unmark all <title>` answers
      "📌 This clears all N marks of `<title>`, set by K listeners…" and clears nothing.
      `!book unmark all <title> confirm` answers "📌 Cleared all N marks of `<title>`", and
      `!book marks` then says there are none.
- [ ] During the closing credits (or an intro), press ◀ to the last chapter's page and press 📌:
      "📌 The narrator is not reading the ebook here…", and nothing is stored.
- [ ] Shared: a second account plays the same recording (another server, or after the first
      stops) with `!book text on`. After the first account marks, the second account's page shows
      "marked" in its footer within a couple of seconds, and `!book text` for either says "📌 N sync
      marks on this recording". Another narration of the same book shows no marks.
- [ ] Text changed: relink the book to another copy of its ebook (`!book link <title> id:N`, or
      edit the EPUB in Calibre). `!book marks` flags the old marks "not used (old ebook text)", and
      pages no longer say "marked". Linking back brings them back.
- [ ] `npm run logs -- --raw` after a 📌: the click and the page edit show no book text, and the bot
      log has `Read-along: mark <8 hex> at N ms, word N.` with no words.

**Nothing in the logs**

- [ ] `npm run logs -- --raw`: every DM page and private page shows as `[book text not logged]`,
      while ordinary replies are logged as written.
- [ ] Search `data/logs/` for a distinctive sentence from a page you read: no hit in
      `commands-*.jsonl` or `bot-*.log`.

**Priority and stutter**

- [ ] The first read of a large ebook while a book plays (Rhythm of War, if it has not been read
      yet): listen for a stutter while "Preparing" shows. With `voiceHealthEnabled` on, run
      `!voicehealth mark first read` and check that minute.
- [ ] Task Manager → Details during that first read: a second, short-lived `node.exe` whose
      command line ends `helpers\epubTextWorker.js --epub-text-child`, at Below normal, while the
      bot's own `node.exe` stays Above normal. It exits within seconds.
- [ ] With Process Lasso running, that child shows up there too for those seconds; this is
      expected. ProBalance was seen on 2026-10-09 lowering a busy node process to Below normal
      with no call from the process itself, which overrides the bot's Above normal exactly when
      it is busy, and an ffmpeg spawned meanwhile inherits Below normal. Exclude `node.exe` and
      `ffmpeg.exe` from ProBalance. The parse child needs nothing more: the bot already runs it at
      Below normal.

## Phase 10: Catalog accuracy and book metadata (live)

Built and unit-tested offline (`npm test` 1,727 of 1,727 on 2026-10-16), and checked by scratch
gates against a read-only snapshot of this library with every store on temp files. None of it has
run in the live bot. The first start after the update rebuilds the catalog once (rules version 3).
Run everything as the owner with prefix commands, and keep the bot log open for "Audiobook tag
reads still running" and "Online book lookup ... failed".

**The first rebuild**

- [ ] Before updating, `!book shelf` as the listener with a place in the old "Music" work (1:08:33
      into All Systems Red) shows it there. Note the time.
- [ ] Start the bot. The start-up check rebuilds the catalog, and that build makes the one rename:
      its log line reads "Audiobook catalog rebuilt: 22 works (21 books, 1 podcasts), N parts, 1
      renamed". If the tag reads ran past 45 s the log also says "Audiobook tag reads still running
      after 45 s (N left)", and one more rebuild follows with its own "1 renamed" (the work passes
      through `untitled/all-systems-red` first). During the reads Task Manager → Details shows at
      most two `ffmpeg.exe` children, at Below normal. `data/book_tags.json` exists afterwards.
- [ ] `!book rescan`: the start message says "up to a minute the first time after an update". The
      reply has 22 works (21 books, 1 podcast), no "↪ Renamed" line (the start-up build already
      made the rename), no "Doubtful groups" line and no "Music split off" line, and no drive
      letter anywhere. A second `!book rescan` renames nothing either and takes about 20 s (the
      tags come from the cache).
- [ ] `!book library`: "The Murderbot Diaries · Martha Wells" with "#1 All Systems Red
      (GraphicAudio)"; no work called "Music"; Mistborn #1–7, each "(Terence Aselford)", which is
      now the edition only; The Stormlight Archive from "#0.5 Edgedancer"; "Words of Radiance",
      "The Once and Future King" and "The Children's Adventure" spelled that way; no line starting
      "#null".
- [ ] **Your bookmark followed the book:** `!book shelf` lists All Systems Red, not "Music", at the
      noted place, and `!book play all systems red` resumes there (less the usual rewind).
- [ ] **The Tyler album is music again:** `!album wolf` plays it with no "📚 Also in your books"
      line, and `!random` or `/vibe` can pick its instrumentals again. `!book library` never lists
      them.
- [ ] `git status` in the bot folder lists nothing under `data/`: `data/book_tags.json` (and later
      `data/book_lookup.json` and `data/book_overrides.json.bak`) are gitignored.

**The card's chapter words**

- [ ] The Once and Future King, `!book goto 30:00:00`: the card reads "**Book N · Chapter N** ·
      <that book's title>", never "Chapter 240 of 319".
- [ ] `!book chapter` there lists lines like "240 · Book 4 · Chapter 7 · The Candle in the Wind
      (N min)", and
      `!book chapter 240` jumps to that slot. The `/book chapter` autocomplete shows the same words.
- [ ] Other books: The Way of Kings shows "Chapter 21" or "Prologue"; All Systems Red "Section 1 of
      3"; Oathbringer's 13th part "Part 13 of 31 · Section 1 of 6"; the podcast "Episode 3 of 8";
      The Final Empire "Part 7 of 19" with no repeated track title.
- [ ] `!book stop` mid-chapter: the ended card says "Saved at … (Book 4 · Chapter 7) of …", and
      `!book shelf` uses the same words.

**`!book edit`**

- [ ] As anyone but the owner: "⛔ Only the bot owner can edit book details."
- [ ] `!book edit Hyperion`: one line per detail with its source, such as "Title: Hyperion · Plex",
      "Narrator: Various · folder name" and "Series: -".
- [ ] The Dan Simmons series, one command per book:

      ```
      !book edit Hyperion author-series Hyperion Cantos 1
      !book edit The Fall of Hyperion author-series Hyperion Cantos 2
      !book edit Endymion author-series Hyperion Cantos 3
      !book edit The Rise of Endymion author-series Hyperion Cantos 4
      ```

      Each reply lists the series so far; the fourth reads "✏️ Hyperion Cantos, for every Dan
      Simmons book: Hyperion #1, The Fall of Hyperion #2 (2 recordings), Endymion #3 (2
      recordings), The Rise of Endymion #4 (2 recordings) (your edit wins over every other
      source)." At once,
      with no rescan, `!book library` shows "Hyperion Cantos · Dan Simmons" with all seven
      recordings numbered 1–4. `data/book_overrides.json` holds only `authors` → `dan-simmons`,
      and `book_overrides.json.bak` appears from the second command on.
- [ ] `!book edit Hyperion` now says "Series: Hyperion Cantos #1 · your author-wide edit", with no
      "number from" part. `!book rescan` renames nothing and the series stays.
- [ ] `!book edit dan-simmons/hyperion narrator none`: no narrator on the card or in the library.
      `!book edit dan-simmons/hyperion clear narrator` brings "Various" back.
- [ ] `!book edit The Fall of Hyperion narrator Somebody`: refused with both recordings' ids, since
      a narrator belongs to one recording.
- [ ] `!book edit The Fall of Hyperion series Test 9`: the reply names both recordings. Then
      `!book edit The Fall of Hyperion clear series`: both are back to Hyperion Cantos #2.
- [ ] Break `data/book_overrides.json` (delete one brace), then `!book edit Hyperion title X`:
      "⚠️ book_overrides.json: the file is not valid JSON (line N column M), so nothing was
      changed.", with no path, and the file is exactly as you left it. `!book rescan` reports the
      error too. Fix the file.
- [ ] Exclude and include on a book you can spare for a minute: `!book edit <id> exclude` says
      "Rebuilding the catalog, about 20 s", then "✅ … is out of the catalog"; its tracks turn up in
      music searches, and its entry in `data/book_overrides.json` holds `"exclude": true` and the
      book's `folderKey`. `!book edit <id> include` brings it back under the same id, removes both
      keys, and a place saved in it resumes.
- [ ] If you can reach the test guild where slash commands register: `/book edit title:Hyperion`
      shows the details, and `/book edit title:<a book> field:series value:Area 51` sets a series
      named "Area 51" with no number. Clear it afterwards.

**The online lookup**

- [ ] Off, the default: `!book edit Hyperion lookup` says the online lookup is off, `!book rescan`
      has no 🌐 line, and no `data/book_lookup.json` appears.
- [ ] `/config` → Audiobooks → "Look up series and narrators online" shows a warning that it sends
      each book's title and author. Turn it on.
- [ ] `!book rescan`: the start message adds "Then it looks books up online, up to a minute more."
      The reply ends with "🌐 Online lookup: …" counts (1 skipped, the podcast) and a "🌐 Filled in
      online" line. With the answers saved on 2026-10-16 that was publisher Audible Studios on
      Hyperion and on The Fall of Hyperion (Bevine), and series "Once and Future King" with
      publisher Naxos AudioBooks on The Once and Future King; today's answers may differ. If the
      minute ran out, the reply says the lookups are still running, and `!book library` shows the
      fills a little later.
- [ ] **Nothing was replaced:** Edgedancer is still #0.5, "The Murderbot Diaries" keeps its "The",
      Mistborn has no narrator, the Hyperion Cantos numbers beat Audible's "Hyperion", and "Words
      of Radiance" keeps its capitals.
- [ ] The bot log shows no lookup warning, or one naming only a title and an author. The batch
      took about 20 s for 21 books, one request a second.
- [ ] A second `!book rescan` straight away: the counts say "21 already looked up, 1 skipped",
      and no new requests go out.
- [ ] `!book edit Hyperion lookup`: "found this recording" or "found the book", then either what
      it filled or "nothing was blank, and online details only fill blanks".
- [ ] `!book rescan`, and while it is still looking books up, `!book edit Hyperion lookup`: the
      first reply adds "after the batch of lookups running now", and the answer follows once that
      batch ends (within a minute), with no "try again".
- [ ] Turn the setting off, `!book rescan`: no 🌐 line, and the online fills (those publishers,
      the T. H. White series) are gone from `!book library` and `!book edit`. The cache file stays.

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
