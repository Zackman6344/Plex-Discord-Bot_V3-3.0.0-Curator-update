# Bug-testing checklist

Practical pass for this bot. Phase 0 is the `/play` symptom specifically; Phases 1–6 are the
repeatable sweep to run after any change that touches dispatch, commands, or deps. Phases 7, 8
and 9 are the first live pass of the audiobook suite, of the voice-health log and process
priority, and of the audiobook read-along, none of which has met a real voice channel yet.
Phase 10 is the first live pass of the catalog's rules version 3: embedded tags, book metadata,
`!book edit`, the optional online lookup and the card's chapter words. Phase 11 is the first live
pass of rules version 5 and what came with it: the one-time id move, short works, typo and series
plays, the sectioned library, the Calibre index and `!book calibre`. Phase 12 checks that sends
made while the PC has lost Discord arrive late, and once. Phase 13 is the first live pass of the
read-along's MOBI and AZW3 conversion and of `audiobookControls`, who may use a book card. Phase 14
is the first live pass of chapter markers inside single-file books, Phase 15 of the read-along's
pictures from a scanned PDF, Phase 16 of `!ap next` loading when its room connects, from the
bot's own copy of the seed, with pages and ⭐ hints, and Phase 17 of the Plex Media world: an
Archipelago game made from the Plex library, with its accounts and consent, lists made in the
Archipelago Options Creator, every way a play is counted, and an upload to archipelago.gg.

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
      `Registered 57 slash commands in guild 396106436326981642 (instant).`
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
- [ ] `Loaded 57 commands (4 aliases)`: any `Failed to load N command file(s)` line means a
      command file is broken and **silently unavailable on both paths**.
- [ ] `Registered N slash commands …`: N should equal the number of slash-declaring commands
      (57 on 2026-11-12, with `/apmedia`; the aliases `?`, `plextest`, `archipelago` and `books`
      are correctly excluded).
- [ ] Health monitor / event server / presence / theater lines appear as expected for the
      toggles in config, and `Plex Media started.` when `apMediaEnabled` is on.
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
All 57 specs passed on 2026-11-12, 35,367 bytes of registration payload: the largest is
`/apmedia` at 2,958 characters (11 subcommands), then `/book` at 2,917 (24) and `/ap` at 2,783
(22).

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
      library (about 20 s)"; a minute later `/book library` lists the sections. The help
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
      control the book is told whose book it is, and the book plays on.
- [ ] The old now-playing card's Pause/Resume on a parked book resumes it.
- [ ] Someone the `audiobookControls` setting leaves out, clicking the card's controls, gets the
      private "This is …'s book" refusal; the owner, and someone in the channel after the listener
      left, can pause and stop. Phase 13 goes through each mode.
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
**After rules version 5 some expectations here read differently:** a bare `!book library` opens
the section landing (use `!book library series:mistborn` and the like for the series lists below),
the Mistborn works show no edition rather than "(Terence Aselford)", and Hyperion shows edition
"Various" with no narrator. Phase 11 covers those changes.
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

## Phase 11: Rules version 5, search, the sectioned library and the Calibre index (live)

Built and unit-tested offline on 2026-10-27 (the last full run 1,939 of 1,940; the one failure is
the contention-sensitive read-along stall test, which passes alone). Checked against a rebuilt
copy of this library and, for the Calibre index, against the live Calibre server read-only. None
of it has run in the live bot. The first start after the update rebuilds the catalog once and
moves about 19 ids. Run as the owner with prefix commands unless a step says otherwise, and keep
`npm run logs -- --raw` and the bot log open.

**Before updating**

- [ ] `!book shelf` as each listener with a place saved (14 places on 2026-10-27). Note each
      book's title and time, in particular Whalefall, The Eye of the World and The Way of Kings
      (in Prologue, about 38:43).
- [ ] Copy `data/book_bookmarks.json`, `data/book_overrides.json` and `data/book_text/links.json`
      somewhere outside the bot folder, so a bad move can be undone.

**The first rebuild**

- [ ] Start the bot. The start-up check rebuilds with "rules changed". The log line reads
      "Audiobook catalog rebuilt: 81 works (80 books, 1 podcasts), N parts, N renamed", with about
      19 renamed. If the tag reads pass 45 s (about 340 new files) the log says so and one more
      rebuild follows. At most two `ffmpeg.exe` children run at once, at Below normal.
- [ ] The bot log has no "Audiobook catalog: two works came out as ..." line. If one appears,
      note both ids: one of them now carries its folder's name.
- [ ] `!book rescan`: 81 works, no "↪ Renamed" line (the start-up build made them), no drive
      letter anywhere. The doubtful line names 3 books: Myths Reimagined (no author found), The
      Odyssey (tracks by Homer and Anthony Quayle) and Matt Bates' The Greek Myths (title reads
      like a credit).
- [ ] The rescan's "🗂 Long groups not taken as books" line shows 5 entries and "N more", with
      shorter groups written like "X (1.2 h, tracks of 10 min)", Bo Burnham's "what" first, and
      music-genre folders last.
- [ ] A second `!book rescan` renames nothing and takes about 20 s.
- [ ] `git status` in the bot folder lists nothing under `data/` (`book_calibre.json` included).

**Short works and the split**

- [ ] `!book library section:myth` (or the Mythology section) lists Lysistrata, Medea,
      Theogony, Galatea and Antigone, and The Birds, The Clouds and The Frogs by Aristophanes as
      three books. `!book play the clouds` starts at its first file.
- [ ] `!album lysistrata` (or any of those plays) shows no music hit and the "📚 Also in your
      books" line instead; `!random` never picks their tracks.
- [ ] The Story of Theseus LP is in the catalog, shown as by Anthony Quayle. Decide whether to
      keep it: `!book edit <its id> author Nathaniel Hawthorne` and a title edit, or `exclude`.
- [ ] Euripides stays one book (titled "Alcestis [438 B.C.]") and the Quayle Odyssey LP one book.

**Bookmarks after the id move**

- [ ] Every listener's `!book shelf` lists the same books at the noted times, under the new
      titles (Whalefall, not "Whalefall - A Novel"; The Eye of the World, not "... Book One of the
      Wheel of Time").
- [ ] `!book play whalefall` resumes at the noted place, less the usual rewind. Same for The Eye
      of the World.
- [ ] The Way of Kings: `!book play the way of kings` resumes in the Prologue at the noted time.
      `!book chapter` now lists the volume-1 intro first and Prelude second.
- [ ] `data/book_bookmarks.json` now keys those places by the new ids (the re-key happens on the
      first read of each).
- [ ] The Eye of the World read-along: with it playing, `!book text` names its Calibre book (#7) though the link in
      `links.json` is still under the old id.
- [ ] `!book edit Hyperion` still shows the Dan Simmons author-wide series from your overrides.

**Typo plays**

- [ ] `!book play Rouge Protocol`: "Nothing in the audiobook library matches "Rouge Protocol".
      Did you mean **Rogue Protocol**?" with one ▶ button, and nothing starts. Press the button:
      the book starts for you.
- [ ] `!book play artifical condition` and `!book start Artifical Conditioon`: Did you mean
      Artificial Condition, nothing starts.
- [ ] `!book play oddysey`: up to 3 suggestions, each with a button. `!book play auto`: plain
      "Nothing in the audiobook library matches", no suggestion.
- [ ] `!book pasue`: "Did you mean `!book pause`?". `!book read Artifical
      Condition`: 'Unknown book command "read". Did you mean `!book play Artificial Condition`?'
      with a button.
- [ ] `!book finish rouge protocol`: text only, with the id to copy, no button.
- [ ] On `/` in the test guild: `/book play title:rouge prot` autocomplete offers Rogue Protocol.
      Then `npm run logs -- --command=book` shows that invocation with `[typed "rouge prot"]`.

**Series and author plays**

- [ ] `!book play murderbot` resumes your newest Murderbot book in progress; with none in progress
      it starts the lowest unfinished number. `!book play murderbot 2` starts Artificial
      Condition, and `!book play murderbot #9` says the series has no #9 and lists the numbers it
      has, with buttons.
- [ ] `!book play mistborn` resumes The Final Empire (or your Mistborn book in progress).
      `!book play mistborn 3` starts The Hero of Ages.
- [ ] `!book play sanderson`: resumes your newest Sanderson book in progress.
- [ ] `!book play stephen fry`: "Which one?" with all 4 of his books and 4 buttons (one button
      used to be missing for an id over 100 characters).
- [ ] `!book play odyssey` asks between Fry's Odyssey and Homer's The Odyssey. `!book play the
      mythos` starts Mythos, not Heroes.
- [ ] With nothing typed but a title: `!book whale fall` offers Whalefall, `!book murderbot 2`
      Artificial Condition, `!book oath bringer` Oathbringer, `!book mistborn` your Mistborn book,
      each with a play button and nothing started. `!book exit strategy` offers the book and
      `!book edit strategy`.
- [ ] `!book play ???` and `!book finish ?` with one book in progress: "Nothing in the audiobook
      library matches"; nothing starts and the book stays unfinished.
- [ ] Finish one narration of The Fall of Hyperion and Hyperion: `!book play hyperion cantos`
      offers Endymion (#3), not the other Fall of Hyperion.
- [ ] `!book link auto` with your book playing: "📖 For **<Title>**, the book playing here:" and
      then the link reply. With nothing playing it names "your most recent book".

**The library landing, sections, pager and play menu**

- [ ] `!book library`: one line per section, about Mythology 42, Fantasy 14, Science Fiction 14,
      Myth Retellings 9, Mystery & Thriller 1, Podcasts 1 (last), no "More books". Below it an
      "Open a section" menu and "▶ Play a book in progress…" listing your unfinished books, newest
      first.
- [ ] Open Mythology from the menu: page 1 of 2, 25 books, "◀ 1/2 ▶" and "📚 All sections". ▶
      shows page 2; a series that runs over the page break repeats its heading with "(cont.)".
      "📚 All sections" goes back to the landing.
- [ ] Fantasy lists books outside a series first, then "*Mistborn* · Brandon Sanderson" and
      "*The Stormlight Archive* · Brandon Sanderson" (under S) in series order, with your marks.
- [ ] Pick a book from "▶ Play one of these…": it starts for you, a private reply says so, and the
      list redraws with the pick cleared. Pick the same book again: it answers again.
- [ ] Someone else picks from your prefix list: the book plays for them, and the list keeps
      showing your marks.
- [ ] `/book library` in the test guild: the reply is private. `/restart`, then click ▶: the page
      turns (the list lives in the same process).
- [ ] Stop and start the bot process, then click one of that list's buttons: "This list has
      expired. Run `/book library` again." privately.
- [ ] Leave a list alone for over an hour, click ▶: the same expired line (with `!book library`
      for a prefix list).

**Library filters**

- [ ] `!book library author:sanderson` (12), `author:wells` (7), `series:murderbot` (7),
      `unread`, `listening`, `finished`, `short`, `long`, `podcasts` (1): each list matches its
      name.
- [ ] Combined: `!book library fantasy unread`, `!book library short unread`, `!book library
      author:sanderson listening`, `!book library fantasy sanderson` and `!book library sanderson
      fantasy` (both 12).
- [ ] `!book library oddysey`: Did you mean, with buttons. `!book library zzqq`: the section names
      and the filter keywords, no buttons.
- [ ] `!book library series:"the long earth"` quoted reads the whole name; unquoted, "long" is
      taken as the length keyword (a known gap).

**`!book calibre` with Calibre open**

- [ ] With `audiobookCalibreSort` off: `!book calibre` says the Calibre index is off and how to
      turn it on, and `data/book_calibre.json` does not exist.
- [ ] `/config` → Audiobooks → "Sort and fill details from Calibre" on. Within a few seconds of
      the next rebuild (or `!book calibre refresh`, which replies at once) the file appears.
- [ ] `!book calibre`: "📚 Calibre matches · 80 audiobooks: 4 exact, 0 pinned, 0 likely, 0 ambiguous, 76 with no
      match" on 2026-10-27, the number of Calibre books and when they were read, "Calibre
      answered at the last check", then the list of books with no match, in up to 3 messages, each
      under 2,000 characters, with no path. Today's counts may differ if Calibre was edited.
- [ ] `!book calibre all` adds the 4 matched books: The Final Empire (#299), The Way of Kings
      (#1), The Eye of the World (#7, by link) and The Once and Future King (#350).
- [ ] The Calibre access log, or a second `!book calibre refresh` a minute later, shows an
      unchanged library costs 2 requests and no full read.
- [ ] As a non-owner, `!book calibre` is refused.
- [ ] The Martian (Calibre #351, author "Weir, Andy") is an exact match after
      `!book calibre refresh`, and `!book edit The Martian` shows "Calibre: #351".

**`!book calibre` with Calibre closed**

- [ ] Close the Calibre app. `!book calibre refresh`: the reply comes at once; a later
      `!book calibre` says Calibre did not answer at the last check, that the saved copy is used,
      and when the next automatic try is. The counts are unchanged.
- [ ] The bot log has one line for the outage, not one per 15-minute check.
- [ ] `!book library` and `!book edit The Way of Kings` still show its section and Calibre line
      from the saved copy.
- [ ] Open Calibre again. Within 15 to 30 minutes, or at once with `!book calibre refresh`, the
      report says Calibre answered.

**`!book edit genre` and `calibre`**

- [ ] `!book edit Hyperion genre Space Opera`: the reply names every recording of the title.
      `!book library` shows a new "Space Opera" section holding them; `!book edit Hyperion` shows
      "Section: Space Opera" and that your edit decided it. `!book edit Hyperion clear genre`
      puts them back in Science Fiction.
- [ ] `!book edit Hyperion author-genre Horror`: every Dan Simmons book without its own genre
      moves to Horror. `!book edit Hyperion clear author-genre` undoes it.
- [ ] `!book edit Hyperion genre none` is refused and names `clear genre`.
- [ ] `!book edit "The Fall of Hyperion" calibre 42`: refused with both recordings' ids. Then
      `!book edit <one id> calibre <a real Calibre id>`: the reply names the record;
      `!book edit <that id>` shows "Calibre: #N … · your pin"; `!book calibre` counts 1 pinned.
- [ ] `!book edit <that id> calibre none`: "Calibre: none, by your edit", and `!book calibre`
      counts it as set to none. `!book edit <that id> clear calibre` returns it to no match.
- [ ] Pin a book to an id the saved copy lacks (`calibre 999999`): the reply says the saved copy
      has no such book and that `!book calibre` will show whether the pin holds; the report lists
      it under pins to check.
- [ ] With `audiobookCalibreSort` off, `!book edit <book> calibre 1` still saves and says it
      applies once the index is on.
- [ ] `!book edit <book> clear all` keeps the genre and the Calibre pin.
- [ ] `data/book_overrides.json` holds `genre`, `calibreId`, `calibreUuid` and `calibreLibrary`
      under the work ids, and `genre` under `authors` for the author-wide one. Clean up the test
      edits afterwards.

## Phase 12: Sends through a connection drop (live)

Before 2026-10-29 every send made while the PC could not reach discord.com failed at once:
now-playing messages, book card updates, command replies and AP relay posts. They are now held
for up to about 2 minutes. To drop the connection, turn Wi-Fi off (or pull the cable) for about
30 seconds; the voice audio stops too, which is expected.

- [ ] Start a book. Type `!book rescan` and drop the network the moment it is sent, so the bot
      has the command and its reply goes out during the drop (a command typed during the drop
      only reaches the bot after it). Restore the network after about 30 s.
- [ ] The bot log shows `Discord is unreachable; holding sends and retrying` once, and after the
      network is back `Discord reachable again after N s; K sends went through late` with K of 1
      or more and no `gave up`.
- [ ] The `!book rescan` reply arrives once, late. Scroll up: no second copy.
- [ ] The book card catches up to the current chapter and position within about 15 s of the
      network coming back (a held send can wait up to 15 s for its next try), and there is no
      `Audiobook card update failed` line.
- [ ] Repeat with music: a track that starts during the drop gets its `**Playing :**` message
      once, late, and the log has no `Unhandled promise rejection`.
- [ ] Drop the network for over 2 minutes: the log has `Discord send gave up after N s` lines
      (or `may have gone through`) and the reachable line ends with `, J gave up`. The bot stays
      up.

## Phase 13: MOBI and AZW3 read-along, and who may use a book card (live)

Built and unit-tested offline on 2026-10-31 with a fake `ebook-convert` (a Node script that
writes a synthetic EPUB, or hangs, fails or prints Calibre's DRM error) and synthetic books.
The real `ebook-convert` ran only in measurements: 3.0 s for a 0.9 MB MOBI and 6.0 s for a
2.7 MB AZW3 at Below Normal. Watch the bot log (`data/logs/bot-<date>.log`; Plex Bot Status shows
its tail) for `Read-along:` lines while you go; `npm run logs -- --raw` reads only the command log.

**📖 on Hyperion and Whalefall** (Calibre #352, MOBI, and #353, AZW3; Calibre open, its
content server started)

- [ ] `!book calibre all` lists Hyperion "MOBI only, converted to EPUB the first time its text
      opens" and Whalefall the same with AZW3. Neither is under "Matched, but Calibre gives the
      read-along no text".
- [ ] Start Whalefall. The card shows 📖. `!book text` says an ebook was found and adds "🔄 Calibre
      has this book as AZW3; it is converted to EPUB the first time its text opens…". Nothing has
      been converted yet: no `converted the AZW3` line in the log.
- [ ] Press 📖. A private page arrives within about 10 s. The log has exactly one
      `Read-along: converted the AZW3 of Calibre #353 (cache <16 hex>) to EPUB in N ms, N bytes.`
      and then `Read-along: read the ebook for cache <16 hex>: N sections, N words in N ms.`
      Task Manager shows `ebook-convert.exe` at Below normal while it runs, and no
      `ebook-convert.exe` afterwards.
- [ ] `!book text` now says "text from Calibre #353 (AZW3, converted to EPUB)". Press 📖 again,
      `!restart`, start the book again and press 📖: no second `converted` line.
- [ ] `data/book_text/cache/` holds the `.txt` and `.json` pair and no `.convert` folder; `%TEMP%`
      has no new `calibre-*` folder from the conversion.
- [ ] In Calibre, Whalefall (#353) still has only its AZW3: no EPUB was added to the record.
- [ ] Repeat with Hyperion (#352, MOBI): 📖 shows, the first open converts once, the text is
      English.
- [ ] `/config` → Audiobooks → turn "Convert MOBI/AZW3 ebooks for read-along" off. Whalefall and
      Hyperion still open from the cache. `!book calibre all` says "converted earlier, so its text
      still opens; new conversions are off". Turn it back on.

**Who may use a book card** (`/config` → Audiobooks → "Who can use a book card's buttons").
Needs a second account (B) in the voice channel before the book starts and a third (C) that joins
after it starts.

- [ ] Default `started`: A starts a book with B already in the channel. B's ⏩, chapter, speed and
      Pause work. C joins, presses ⏩: a private "This is A's book. Only people who were in 🔊 …
      when this book started, and are still in it, can use its buttons. …". The book help embed
      says the same at the end of MOVING AROUND.
- [ ] B leaves the channel and presses ⏩: refused with the same text. B rejoins: ⏩ works again.
- [ ] A leaves the channel: the book parks. B (and C) press ⏯, ⏩ and speed: each is refused
      with "A has left 🔊 …, so the book waits for them to come back. Until then anyone in it may
      pause or stop." A rejoins: B's ⏯ now resumes it. Last, with A away again, B's Stop ends it.
- [ ] `voice`: C, who joined late, may seek; someone in another channel may not.
- [ ] `listener`: B and C are refused everything but, once A has left, pause and stop.
- [ ] `everyone`: someone in no voice channel at all may seek while A is in the channel.
- [ ] Each change applies to the next click, with no restart and no new card.
- [ ] In every mode B's 📖 page has no ↪ or 📩, and the owner (not in voice) may pause and stop.

## Phase 14: Chapter markers in single-file books (live)

Built and unit-tested offline on 2026-11-05 with synthetic books, and measured on the live catalog
and Calibre's EPUBs read in memory: 7 maps change (The Martian, The Eye of the World, Assassin's
Apprentice, Royal Assassin, Assassin's Quest, Fool's Quest, Fool's Fate) and every other book's
map stays the same. No catalog rebuild is needed. `/book goto 4:35:00` (or `!book goto`) reaches
the times below.

- [ ] The Martian (Calibre #351) at 4:35:00, inside chapter 14's audio log: 📖 shows chapter 14,
      and the footer says "chapter-level". `!book text` says "chapter-level for 96% of the audio".
- [ ] The Martian at 0:00:10 (opening credits) and at 10:35:00 ("Diary of an AssCan", bonus audio
      the ebook lacks): "No text for this part of the audio". 📌 there is refused with the
      no-text note.
- [ ] The Martian, near the end of a chapter: ▶ to the next chapter's first page and press 📌:
      "📌 That page is outside the chapter now playing…", nothing stored.
- [ ] Royal Assassin (#371) at 0:05:00: the page is in the Prologue ("Dreams and Awakenings"), and
      the footer says "chapter-level".
- [ ] The Eye of the World (#7) at 0:10:00: the page is in the Prologue, "estimated from pace". At
      0:20:00 it is in chapter 1, "An Empty Road", "chapter-level".
- [ ] Dragon Keeper (#356), whose markers follow the publisher's numbering: every page still says
      "estimated from pace", and `!book text` says "estimated from pace (no track is named after a
      chapter)".

## Phase 15: Read-along pictures from a scanned PDF (live)

Built and unit-tested offline on 2026-11-05 and 2026-11-06 with fake PDF tools and generated
books, then run outside the bot on Calibre #384 with the real tools and the real Calibre, once as
built and once after the review's fix pass. The second run: 264 pages in 371 s at Below Normal
while other apps kept the PC busy (the first took 223 s), 119 pictures (114 placed), and all 17
chapter openers on their chapter's first word. No step covers `pictures:redo` on an analysis two
narrations of one book share, or the longer time cap of a PDF over 500 pages; both are unit-tested
only. Calibre open, #384 holding its EPUB and PDF. Page numbers below are the PDF's own (the
printed page number is 12 less). Watch the bot log (`data/logs/bot-<date>.log`; Plex Bot Status
shows its tail) for `Read-along pictures:` lines; `npm run logs -- --raw` reads only the command
log, for the redaction step below.

- [ ] `/config` → Audiobooks shows "Read-along pictures from a Calibre PDF" off. Turn it on; no
      restart.
- [ ] Start Harry Potter and the Sorcerer's Stone with `!book text on`. `!book text` names Calibre
      #384 and adds "🖼 Reading Calibre #384's PDF for pictures: page N of 264 (a few minutes,
      once)." (without the page for its first few seconds). Task Manager → Details, with the Base
      priority and Command line columns added, shows the node child (`--book-pictures-child` in
      its command line) and `pdftoppm.exe` at Below normal, and any `ffmpeg.exe` whose command
      line has `-f ppm_pipe -i pipe:0` at Below normal too (each lasts under a second, so one may
      not show). The book's own `ffmpeg.exe` stays at Normal. The voice does not stutter while it
      runs.
- [ ] When it ends, about 4 to 6 minutes later, the bot log has exactly one `Read-along pictures:
      read the PDF for pictures 9aa360b44c75c103: 264 pages, 119 pictures (6 spreads) in N ms.`,
      with nothing between `ms` and the full stop (a `; pages skipped:` tail means pages or
      pictures were lost), and no title or path in any line. `!book text` now says "🖼 114
      pictures from Calibre #384's PDF show on your page as the narration reaches them."
- [ ] `data/book_text/pictures/9aa360b44c75c103/` holds `index.json`, `pages.json`, one
      `align-<16 hex>.json` and 119 JPGs; there is no `.work` or `.old` folder and no PDF anywhere
      under `data/`. In Calibre, #384 still has exactly its EPUB and PDF.
- [ ] At chapter 1's first page the DM page shows two pictures: the frontispiece (page 12) in the
      page's own card and the chapter opener (13) under it. The next turn (about a minute in)
      shows page 14's picture alone in their place, and the turn after it (about 2 minutes 20
      seconds in) leaves the message with no attachment.
- [ ] The pictures' alt text (Discord's ALT label on an image, or a screen reader) gives the
      printed page: the chapter opener's reads "Picture from the printed book, page 1", and the
      frontispiece's has no page number.
- [ ] Pages 62 and 63 (the hut on the rock) show as one wide picture with chapter 5's opener; its
      alt text reads "Picture from the printed book, pages 50 and 51".
- [ ] ◀ onto a picture page and ▶ off it: the picture comes and goes. 📍 Now follows again.
- [ ] Pause on a picture page: "⏸ paused" with the picture still there.
- [ ] 📖 on the card, as the listener and as a second account in the voice channel: the same
      picture, privately. The second account leaves the channel and presses ▶: the join line, and
      no picture left on screen.
- [ ] `!book text now` on a picture page: the old message says "This page moved ↓" with no picture.
- [ ] Turn the setting off on a picture page: the picture leaves the DM page within a second (an
      open 📖 page keeps its picture until its next click). On again: it returns, and the bot log
      has no new `read the PDF` line.
- [ ] `!book link "Harry Potter and the Sorcerer's Stone"` has a line "🖼 Pictures: 114 from
      Calibre #384's PDF (27.9 MB, 264 pages, <date>), lined up with this text (97% of its pages
      placed)."
- [ ] `!book link "Harry Potter and the Sorcerer's Stone" pictures:off`, then `pictures:on`, then
      `pictures:redo`: the first hides the pictures from the open page at once, the second brings
      them back with no new `read the PDF` line in the bot log, and the last clears them from the
      open page and starts a new analysis, with a reply that starts "🖼 Reading Calibre #384's
      PDF for pictures again".
- [ ] While that analysis runs (`!book text` shows "page N of 264"), turn the setting off: within
      seconds Task Manager has no `pdftoppm.exe` and no Below normal `ffmpeg.exe`, and
      `data/book_text/pictures/` has no `.work` folder. Turn it back on: `!book text` shows the
      PDF being read again from its first pages.
- [ ] `!restart` during that analysis: no `pdftoppm.exe` left in Task Manager, no `.work` folder
      after the restart, and the analysis starts again on the next open.
- [ ] Once the analysis that started again has logged `read the PDF for pictures` in the bot log,
      take the book to the start of a chapter (the card's Next chapter), let it play about 20
      seconds and pause it. Close Calibre, `!restart` and play the book: the first DM page shows
      the chapter's opener, from the cache, with the page or a moment after it.
- [ ] `npm run logs -- --raw`: picture pages are `[book text not logged]`; no `.jpg` name.
- [ ] Stop the book on a picture page: the stub has no picture.
- [ ] With Calibre still closed, play Whalefall (Calibre #353, no PDF; Phase 13 converted and
      cached its text) and let a page open: `!book text` has no 🖼 line, and `!book link
      Whalefall` says "🖼 Pictures: not checked (Calibre isn't answering)." Open Calibre again.
- [ ] Back on Harry Potter, replace #384's PDF in Calibre with a copy of the same file (Add books
      → Add files to selected book records), so its date changes. Within about 10 minutes of
      reading along, or at once after `!restart`, a new analysis starts, and 4 to 6 minutes later
      the bot log has `read the PDF for pictures <another 16 hex>`; until then the old pictures
      keep showing. After the next `!restart` and a page, `data/book_text/pictures/` holds only
      the new key's folder.
- [ ] Replace #384's EPUB the same way. Within about 10 minutes the open page says "The text was
      updated", then within seconds the bot log has `Read-along pictures: lined up <16 hex> with
      text <another 16 hex> in N ms.` and no new `read the PDF` line, and the pictures are back.
      The book's 📌 marks belong to the old copy of the text and stop applying.
- [ ] Look at, and decide on, what the offline runs showed: the chapter 1, 4, 10, 15 and 16
      openers come out as whole printed pages, text included; the troll guide's spread (158, 159)
      comes out as two pictures; and at the end of chapter 17, page 259's painting shows on the
      chapter's last page from about 36:19 into the 37:31 track, while the frog on 260, the back
      endpapers (262, 263) and the back cover (264) never show while following (▶ past the
      chapter's last page still reaches them). A build without the end-matter fix (b28486b)
      shows all four at 33:49–34:23 instead, beside the back matter's own text pages.
- [ ] With `audiobookCalibreSort` on, a test record with only a PDF for an audiobook that has no
      other Calibre record (or pinned to it with `!book edit <book> calibre <id>`): `!book link
      <book>` lists it "(PDF only: no text, so no pictures either)", and `!book calibre` adds "add
      an EPUB, MOBI or AZW3 to the record and its PDF's pictures can show too".

## Phase 16: `!ap next` from a kept copy of the seed, with pages and hints (live)

Built on 2026-11-10 and unit-tested offline, then run outside the bot against the live 35-slot
room (seed 22585070207533418417, generated here on 2026-11-09 with Archipelago 0.6.8): the real
logic worker on the real install, the room's real tracker and hints, and the real command's
replies, with Discord faked. The worker copied the seed's 35 yamls and multidata, was ready 28 s
after it started with 35 of 35 slots verified, and answered the 24 claimed slots in 184 ms. The
build before this change verified 27 of 35 the evening the seed was made, and could not rebuild it
at all once the `Players` folder changed the next morning. With no copy to roll, the worker picked
the seed's 35 yamls out of the 40 in `Players` by player name, was ready in 24 s and verified 35 of
35 (run outside the bot; its bot log line is the same `35/35 slots verified`). Nothing here has run
in the bot or in Discord yet, and none of the 31 hinted locations in those 24 slots was in logic
then, so a starred name has only been seen in the unit tests. Leave the five `ZackMafia*.yaml` in
`C:\ProgramData\Archipelago\Players`; one step depends on them. Watch the bot log
(`data/logs/bot-<date>.log`; Plex Bot Status shows its tail) for `[AP:Configured room]` lines.

**Loading when the room connects**

- [ ] Stop the bot and start it again (`!restart` keeps the room's connection and the running
      worker, so it shows none of this). Type nothing. Within about a minute of `[AP:Configured
      room] connected to`, the bot log has, in this order: `kept a copy of seed
      22585070207533418417's 35 yaml(s) and multidata in ...` (this start only), `[AP:Configured
      room] starting the logic worker for seed 22585070207533418417`, and about 30 s later
      `[AP:Configured room] logic worker ready in N s: 35/35 slots verified against the
      multidata`, with no `answers sphere 1 only` line after it.
- [ ] `data/archipelago/seeds/22585070207533418417/` in the bot's folder holds `players/` with 35
      yamls and no `ZackMafia*.yaml`, `AP_22585070207533418417.zip` (2.2 MB, the size of the one
      in `C:\ProgramData\Archipelago\output`), and `seed.json`, which names seed
      16496140521916006544 and the 35 files. There is no `22585070207533418417.partial` folder
      beside it.
- [ ] Task Manager → Details, with the Command line column added: the `python.exe` running
      `ap-logic-worker.py` has `--players-dir` pointing at that `players` folder.
- [ ] Stop and start the bot again, and type `/ap next` within 10 seconds of the `starting the
      logic worker` line: the reply says the seed's logic is loading, then answers when the
      `ready` line lands. There is no second `starting the logic worker` line, and no `kept a
      copy` line this time.

**Answers and hints**

- [ ] Once the ready line is in, `/ap next`: the answer replaces "🧭 Working out what is open
      across your 24 slot(s)…" within a few seconds, with no "Loading this seed's logic" step.
      Its footer starts "In logic with the items each slot has received" and has no "Sphere 1
      only where the seed's own logic is unavailable".
- [ ] In that reply, a slot whose world holds hinted locations not yet in logic ends its line
      ` · ⭐ N hinted locked`. The footer has "⭐ marks a location somebody has hinted." only when
      a ⭐ shows above it. On 2026-11-10 none of the ten blocks that fit had one, since the 31 were
      in slots the reply cut or named at the end, and the build tested then had the note anyway.
- [ ] `/ap next slot: ZackLL1Warhammer` shows its line (`sphere 1: N in logic` after the name), 15
      names, the italic closing line (`Also in logic: sphere 2 (N) · N still locked`, then
      ` · ⭐ N hinted still locked` while it has one), `Page 1 of N`, the footer, and ◀ ▶ under
      it with ◀ greyed out. On 2026-11-10 it was 228 in sphere 1 and 21 in sphere 2, 17 pages,
      one hinted location locked.
- [ ] When a hinted location in one of your worlds is in logic (none was on 2026-11-10; a `!hint`
      for an item sitting in one of your worlds makes one), `/ap next slot: <that slot>` lists it
      first, as `⭐ <name>`, and no page lists it a second time. Every location `!ap hints <that
      slot>` names in that slot's world is either starred or counted in `⭐ N hinted still
      locked`. `!ap hints` stars only priority hints, so it shows fewer stars.
- [ ] The player waiting on one of those hints marks it Avoid in their Archipelago client's hint
      list: the next `/ap next` neither stars it nor counts it.

**Pages**

- [ ] Press ▶ on the Warhammer reply: the same message turns to page 2, with no new message and
      nobody pinged, and ◀ comes alive. Walk on to where sphere 2 starts: an italic `Sphere 2`
      line comes before its first name, and a page that starts inside sphere 2 opens with that
      line too. Every page keeps the slot's line and the closing line. On the last page ▶ is
      greyed out, and ◀ walks back.
- [ ] `!ap next ZackLL1Warhammer` gets the same pages and buttons as the slash form.
- [ ] A second account presses ▶ on that reply: a private "Only the person who asked can turn
      these pages.", and the page stays where it was. The asker's ▶ still turns it.
- [ ] Leave a paged reply untouched for over 30 minutes, then press ▶: a private "This list has
      expired. Ask for it again to see what is in logic now." A reply turned within the last 30
      minutes still turns, since each turn starts the 30 minutes again.
- [ ] Turn a page, `!restart`, and turn it again: it turns, since the lists live in the process.
      Stop and start the bot, and the same reply's ▶ answers that the list has expired.

**A `Players` folder that has moved on**

- [ ] With the five `ZackMafia*.yaml` still in `Players` (40 yamls in all), stop and start the
      bot: no `kept a copy` line, `35/35 slots verified` again, and no `no longer match` line.
      The build before this change failed exactly here, at 2026-11-10 23:20 UTC: `the Players
      folder no longer matches seed 22585070207533418417 (5 slot(s) differ, first slot 36)`.
- [ ] The fallback when the copy itself is wrong: stop the bot, move one yaml out of the copy's
      `players/` folder to the desktop, and start the bot. The log has one `logic worker ready in
      N s, answering sphere 1 only until the cause is fixed (it tries again after 10 minutes):
      could not rebuild seed 22585070207533418417: RuntimeError('the yamls no longer match ...`
      line and no line per slot. `/ap next` answers every slot `sphere 1 only: N open · N further
      in`, its footer says sphere 1 only is "where the seed's own logic is unavailable (the seed
      could not be rebuilt; the bot log says why)", and it asks for no script.
- [ ] Put the yaml back without stopping the bot. A `/ap next` within ten minutes of the ready
      line still answers sphere 1 only, with no new `starting the logic worker` line. The first
      one after ten minutes logs `starting the logic worker` again, says the seed's logic is
      loading, and answers from the logic, with `35/35 slots verified` in the log.

**When the worker cannot run at all**

- [ ] In `/config` → Archipelago, blank the install (the worker stops), set the Python to
      `C:\nothing\python.exe`, then put the install back. `/ap next`: the reply says the seed's
      logic "could not be loaded; the bot log says why" and gives one command,
      `python scripts\extract-spheres.py "C:\ProgramData\Archipelago\output\AP_22585070207533418417.zip"`.
- [ ] Paste that command as it is into PowerShell in the bot's folder: it writes
      `data\archipelago\spheres\22585070207533418417.json`, and the next `/ap next` answers every
      slot sphere 1 only. Clear the Python setting: the next `/ap next` says the seed's logic is
      loading, and about 30 s later answers from the logic again. Delete that `.json` afterwards.

## Phase 17: Plex Media world (live)

Built on 2026-11-11 and 2026-11-12 and tested offline only. `npm run test:apworld` generated real
seeds with the frozen Archipelago 0.6.8 (solo lists, every kind with every timer, two Plex lists
sharing titles beside ChecksFinder, season mode, 600 unlock copies, an item link): each passed a
copy of archipelago.gg's upload check, MultiServer resolved a title by name, and the `!ap next`
worker rebuilt the seeds it was given and verified every slot. In its scenario G a real
MultiServer hosted one more seed on a loopback port, and the bot's real game, game client and room
monitor played it: a Plex history row sent its title's checks, a locked title's checks waited in
the bank until its unlock arrived through the multiworld, the room recorded the goal, and the relay
never posted the game client's own join or leave. The other bot-side tests ran against a stand-in
room server modelled on MultiServer 0.6.8. Plex and Discord were fakes throughout. Nothing below
has met a room hosted with `ArchipelagoServer.exe` or archipelago.gg, a live Plex session or
Discord yet: `/status/sessions` had no session playing when it was probed, so its field shapes are
unverified, and no seed has been uploaded to archipelago.gg. Watch the bot log
(`data/logs/bot-<date>.log`; Plex Bot Status shows its tail) for `Plex Media` lines, and
`npm run logs -- --raw` for `apmedia-*` events.

World 0.2.0 (2026-11-12) added the list settings that let a player start a YAML in the Archipelago
Options Creator and attach it to `/apmedia yaml`. Its tests copy the Creator's rules from the
0.6.8 build (`OptionsCreator.py` and `data/optionscreator.kv`), make the files it would export with
Archipelago's own code, fill them in through the bot's real reader, and generate them with the
frozen Archipelago. Nobody has opened the Creator's window with this world installed, or attached
a file to the bot in Discord, yet.

You need `ownerId` set, a second Discord account (Friend) with a Plex account of its own on this
server (a shared or a managed user), and a third (Other) with none. The Options Creator steps need
Archipelago 0.6.8's Options Creator on this PC and the `yaml` package in the bot's `node_modules`.
The steps build three test seeds on this PC from folders of their own, so the real `Players`
folder stays as it is, and host them one at a time on port 38281 with `ArchipelagoServer.exe`
from `C:\ProgramData\Archipelago`, whose window takes server commands (`/send`, `/option`). They
run on a watch of their own, added with `!ap watch` (its id is N below), so the room `/config`
names keeps relaying your real game.

**Turning it on, and the apworld**

- [ ] Before enabling: `/apmedia status` answers "🎬 Plex Media is turned off. The bot owner can
      turn it on with `!config`, under AP Media (`apMediaEnabled`).", `!help` has no `!apmedia ?`
      line, and `!diag` shows `− ApMedia: apMediaEnabled is false in config/config.js`.
- [ ] `/config` → AP Media lists six settings. Turn on "Plex Media world (/apmedia)": no restart,
      the bot log has `Plex Media started.`, `!diag` shows `✓ ApMedia: 0 slots, 0 connected, no
      linked accounts`, `!help`'s 🧩 ARCHIPELAGO section ends with the `!apmedia ?` line ("Plex
      Media: your to-watch list as an Archipelago game."), and `!apmedia ?` shows the sub-help.
- [ ] Optional, because turning `archipelagoEnabled` off stops every watch, the live room's relay
      included, and the chat, joins and parts of that pause are never caught up: turn it off, and
      `!diag` shows `⚠ ApMedia: needs the Archipelago monitor (archipelagoEnabled is off): …`. Turn
      it back on: `!diag` is ✓ again.
- [ ] Other runs `/apmedia apworld`: "⛔ Only the bot owner can hand out the apworld.", in public,
      as every `apworld` reply is. You run it: `plex_media.apworld` attached, "the Plex Media world
      0.2.0 (N KB), for Archipelago 0.6.8 or later.", the install steps, and "This PC has no
      plex_media.apworld installed yet (Archipelago's custom_worlds folder)." Where an earlier
      pass installed world 0.1.0, the last line is "⚠️ This PC has world 0.1.0 installed, and
      this file is 0.2.0: install it to bring the PC up to date." instead.
- [ ] Install it (Archipelago Launcher → **Install APWorld**, then restart the Launcher).
      `/apmedia apworld` again: "This PC already has world 0.2.0 installed."
- [ ] An older version: close every Archipelago program, then from the bot's folder run
      `node -e "require('./helpers/apworldBuild.js').writeApworld('C:/ProgramData/Archipelago/custom_worlds/plex_media.apworld', { worldVersion: '0.1.0' })"`.
      `/apmedia apworld`: "⚠️ This PC has world 0.1.0 installed, and this file is 0.2.0: install
      it to bring the PC up to date." `/apmedia yaml name:VersionCheck`, and generate a folder
      holding only `VersionCheck.yaml`. Generation stops, and its error holds
      `Settings reports required version of world "Plex Media" is at least 0.2.0`. Install the
      attached apworld over it: the next `/apmedia apworld` says 0.2.0 again, and the same folder
      generates.

**Accounts and consent**

- [ ] Other runs `/apmedia account`: "⛔ Only the bot owner can see and link Plex accounts." You:
      a private list headed "Plex accounts on this server", your own marked `id 1, the server
      owner`. `!apmedia account` in a channel answers "📬 Sent you the Plex account list by DM.",
      and the list is in your DMs, not the channel.
- [ ] `/apmedia account user:@Friend plex:<the first three letters of their Plex name>`: "No Plex
      account is called `<abc>`. Did you mean `<name>` (id N)? Give its full name or its id.", and
      nothing is linked. `!apmedia account @Friend <abc>` in a channel answers "📬 Sent you the Plex
      accounts that match by DM.", and the question is in your DMs, not the channel.
- [ ] `/apmedia account user:@Friend plex:<their Plex name>`: "<@Friend>: Linked to Plex account
      `<name>` (account N), waiting for their consent: nothing is read until they accept." and
      "📨 They have a DM with an Accept button." Friend's DM says what would be read, that
      `/apmedia account plex:none` takes it back, and has an Accept button. Leave it unpressed.
- [ ] Friend turns off direct messages from server members (the server's Privacy Settings). Link
      them again the same way: "Their DMs are closed to the bot, so this channel asks them to open
      them (naming them without a ping): link them again once they have." The channel message
      starts "<@Friend>: the bot owner linked you to a Plex account for Plex Media, and your DMs are
      closed to the bot.", has no button and no account name, and Friend gets no mention
      notification. Friend turns their DMs back on, and you link them a third time: a new DM.
- [ ] Friend presses the first Accept, in their DMs: the message becomes "The owner has linked
      your Plex account again since this request: answer the newer one." and loses its button.
- [ ] Friend presses the newest Accept: the message gains "✅ Accepted: the Plex history of
      `<name>` (account N) counts for your Plex Media slots." and loses its button.
      `/apmedia account user:@Friend` now ends "accepted".
- [ ] `/apmedia account user:@Other plex:<Friend's Plex name>`: "Plex account `<name>` (id N) is
      already linked to <@Friend>. Unlink it there first, or link it as shared if they use that
      account together. To link it anyway, add `shared:True`." `plex:1` gets the same answer, naming
      you "(as the server owner)". With `shared:True`, Other is linked, waiting, and their
      DM says the account is also linked to <@Friend>. `/apmedia account user:@Other plex:none`.

**Lists from the Options Creator**

- [ ] In the bot's folder, `node -p "require('yaml/package.json').version"` prints `2.9.1`.
      Without the package, every attached file gets "❌ The bot cannot read YAML files yet: the
      owner has to install its yaml package (2.9.1).", and lists built from the command's options
      still work.
- [ ] `/apmedia yaml` with no option at all: "Give the list a slot name: `!apmedia yaml name=You
      movies=10`, or attach a YAML from the Archipelago Options Creator. Options: …"
- [ ] Archipelago Launcher → **Options Creator**. Plex Media is in its game list. Pick it: the
      label above Export Options reads "Game: Plex Media", and the form has five groups, in this
      order: Game Options, Your list (the bot picks the titles), Unlocks and goal, Timesanity, and
      Item & Location Options.
- [ ] Open the three Plex Media groups. Every option in them has a control, and none reads "This
      option isn't supported by the option creator." Your list holds List: Preset, List: Movies,
      List: Shows, List: Albums, List: Audiobooks, List: Titles, List: Playlist, List: Collection,
      List: Genre, List: Years, List: Unwatched Only, List: Episodes per Show and List: Name, in
      that order, and Entries and List Info are in no group. Each list setting's tooltip starts
      "The bot reads this when it fills in your titles (/apmedia yaml):", and List: Preset's gives
      each of the six presets a line of its own.
- [ ] The four counts each show -1 beside a slider at its left end, and a button reading Preset.
      Drag List: Movies' slider right: the number follows it and the button reads Custom. Drag it
      back to the left end: 0 and Custom. Choose Preset from the button: -1 and Preset again.
- [ ] Item & Location Options → Local Items → Edit: searching finds `Unlock 1`, `Wild Ticket` and
      `Everything`, and never a title.
- [ ] Player Name `CreatorFan`, nothing else touched: **Export Options**, saved as
      `CreatorFan.yaml`, gives "File saved successfully." The file has no `requires` and no
      `entries`, and line endings aside it equals
      `apworld/tests/fixtures/options_creator_default.yaml` apart from its `name:` line.
- [ ] Put `CreatorFan.yaml` alone in a folder of its own and generate it
      (`ArchipelagoGenerate.exe --player_files_path <folder>`). Generation stops, and its error
      holds "Plex Media list of CreatorFan: this YAML has no titles yet. Attach it to /apmedia yaml
      in Discord, and the bot picks them from the Plex library."
- [ ] `/apmedia yaml file:CreatorFan.yaml`: a private reply, "📝 `CreatorFan`: your list, attached
      as `CreatorFan.yaml`.", 15 movies, "📄 Settings from `CreatorFan.yaml`.", and no line about a
      random option. In the returned file, `requires` names `Plex Media: 0.2.0`, the 13 list
      settings follow the 12 game options (`list_preset: movies`, each count `preset`), then come
      `progression_balancing: "normal"`, `accessibility: "items"` and the empty item and location
      options, then `list_info` and 15 entries. Generated alone in a folder of its own, it gives no
      Plex Media error.
- [ ] In a channel, `!apmedia yaml` with `CreatorFan.yaml` attached to the message: a public reply
      with a list built the same way.
- [ ] A custom file. In the Creator: Player Name `CreatorMix`, List: Preset `mixed`, List: Movies
      4, two movie titles from the library in List: Titles split by `;`, List: Unwatched Only off,
      List: Name `Movie night`, Random? on for Goal Percent, Timesanity: Movies set to Off from its
      button, and Progression Balancing at 30. Export `CreatorMix.yaml` and attach it to
      `/apmedia yaml`. The reply counts 4 movies, both named ones among them, 4 albums and 1 book
      beside one show's episodes, and has "⚠️ Left random in your file for Archipelago to roll: Goal
      Percent (`goal_percent`), default 80. The numbers above use the default." The returned file has
      `goal_percent: "random"`, `timesanity_movies: 0`, `list_preset: mixed`, `list_movies: 4`,
      `list_shows: preset`, `list_unwatched: false`, `list_label: "Movie night"`, and after the list
      settings `progression_balancing: 30`. Its first line starts
      `# Movie night: Plex Media list built`, and its third reads "# goal_percent stays random until
      Archipelago rolls it: the line above plans it at 80".
- [ ] `/apmedia yaml file:CreatorMix.yaml name:CreatorTwo movies:2 goal-percent:50`: "📄 Settings
      from `CreatorMix.yaml`; the options you typed replace the file's.", attached as
      `CreatorTwo.yaml`, whose only movies are the two named ones, with no line about a random
      option and `goal_percent: 50` in the file.
- [ ] Attach the returned `CreatorMix.yaml`, the bot's file, to `/apmedia yaml`: "♻️ The file's N
      titles were replaced by a fresh pick from Plex.", N being its entry count, and every line from
      `Plex Media:` down to `list_info` equals the attached file's.
- [ ] Refusals, each file attached to `/apmedia yaml`. A Creator file with Random? on for List:
      Movies: "❌ List: Movies (`list_movies`) is random: set a number, the bot needs it to pick
      titles." One with Random? on for List: Movies and List: Shows names both in one reply. One
      with List: Preset `none`, every count at Preset and nothing named: "❌ Your list settings pick
      nothing: choose a preset, set a count, or name titles, a playlist or a collection." A
      ChecksFinder YAML from the Creator, with its `ChecksFinder:` settings: "❌ The file's game is
      `ChecksFinder`, and the bot fills in Plex Media lists only."
- [ ] A Creator file with Random? on for Timesanity: Episodes, and List: Titles naming a show with
      all its seasons (`show: <name> S1-<last>`) whose episodes run 190 hours or more in all, such
      as 520 episodes of 22 minutes: "❌ Timesanity: Episodes (`timesanity_episodes`) is random in
      your file, and a roll of 1 would make N locations (at most 10000): set a number, or use
      random-range-K-240." The same file with `time-episodes:10` typed is accepted. Named without
      its seasons, the show stops at List: Episodes per Show (24) and the file is accepted as it is.
- [ ] A Creator file with List: Playlist set to `Random`, on a server with no playlist called
      exactly Random: "❌ No playlist called `Random`." and the server's playlists, even when one
      is called Random Hits.
- [ ] A Creator file naming the start of a title in List: Titles, such as `Alie` for Alien: the
      list has the film, and the reply says "Nearest matches taken: "Alie" as Alien (1979)."
- [ ] Launcher → **Generate Template Options**, then attach `Plex Media.yaml` from
      `Players\Templates`, the folder it opens: "❌ The name cannot contain {, } or %. That is the
      name in the file: give the slot another with the name option." With `name:TemplateFan`
      typed: 15 movies, as from an untouched Creator form, with no line about a random option, and
      the returned file has `goal_percent: 80` and `list_preset: movies` as plain values.
- [ ] Owner: attach a list the bot built for a friend (their returned file) with nothing typed:
      "❌ This list was built for @Friend. To pick it again for them, add `for:@them`. To make it
      a list of your own, give it a new name with `name:Name`." With `for:@Friend` it builds for
      them. The friend attaching it themselves gets a fresh pick. Another player who changes the
      file's `name:` line to their own name and attaches it gets their own list.
- [ ] Owner: attach your own returned list with `for:@Friend`: "❌ This is your own list. To build
      a new list for @Friend from it, give it a new name with `name:Name`."
- [ ] A friend whose Plex account link waits for their consent: `/apmedia yaml name:Friend`
      replies "❌ Leaving out what you have already watched needs your Plex account, and its link
      waits for you to accept it in the bot's DM (or ask the owner to link it again). Or build the
      list with `unwatched:false`." `/apmedia yaml name:Friend titles:<a show>` builds, with "⚠️
      Your Plex account link waits for you to accept it in the bot's DM: until you do, the bot
      knows nothing you watched." and "⚠️ <show> starts at its first episode: the bot knows nothing
      you have watched."
- [ ] `!apmedia yaml name=Shot movies=2` with a screenshot attached: a list of 2 movies, the
      screenshot left alone. `!apmedia yaml` with a short note pasted as `message.txt` and a
      Creator file attached after it: the reply says "Settings from" the Creator file.
- [ ] Paste a Creator file's text into a `!apmedia yaml` message instead of attaching it: "❌ The
      bot reads a YAML only as a file: drag the file into Discord with `!apmedia yaml` as its
      message, or use `/apmedia yaml file:`."
- [ ] `/apmedia yaml name:Seen titles:show: <a show you have watched to the end>`: "❌ Nothing on
      the list: nothing in the library fits these settings." and "⚠️ <show>: every episode has been
      watched, so it was left out. To keep it, name its seasons (show: <show> S1-<last>) or turn
      unwatched off."
- [ ] Triggers, each in a Creator file under `Plex Media:` and attached to `/apmedia yaml`. One that
      sets `timesanity_episodes: 1` beside a List: Titles of a show that runs 190 hours or more
      (`show: <name> S1-<last>`): "❌ A trigger in your file sets Timesanity: Episodes
      (`timesanity_episodes`), and at 1 the list makes N locations (at most 10000): have the
      trigger set it to K or more." One that sets `list_preset: tv`: "❌ Trigger 1 in your file sets
      List: Preset (`list_preset`), which the bot does not follow: set it in the file itself." One
      with `option_category: plex media`: "❌ Trigger 1 in your file has the option_category `plex
      media`, which Archipelago cannot find in the file: use Plex Media."
- [ ] A list over 64 KB the bot wrote (a show of 400 episodes named with its seasons), with
      `  item_links: []` added as its last line: attached again, it gets a fresh pick and keeps
      `item_links`.
- [ ] With a YAML the bot wrote before this update at hand (from an earlier pass of this phase),
      attach it: "❌ This list comes from an older version of the bot, which did not save what to
      pick: give a preset, a count, or titles, a playlist or a collection with the command." With
      `preset:movies` added: 15 movies, under the old file's own label when it had one. Another
      player who changes that file's `name:` line to their own name and attaches it with
      `preset:movies` gets a list of their own, under their own name's label.

**Lists, and the three seeds**

- [ ] `/apmedia yaml name:ZackPlex preset:mixed time-books:5 time-albums:5`: a private reply with
      `ZackPlex.yaml` attached, a line of counts (entries by kind, locations, hours), "Starts with N
      open; goal: finish K of M", "Next: put the file in Archipelago's Players folder before you
      generate. …", and "Every title on the list is visible to the whole room and on the public
      tracker." Ask for it again before the first answer comes: "⏳ Your last list is still being
      built: wait for it, then ask again."
- [ ] Friend: `/apmedia yaml name:FriendPlex preset:movies`. Check two of its titles against
      Friend's Plex history: neither has been watched on Friend's account. The reply says to send
      the file to the bot owner.
- [ ] Other: `/apmedia yaml name:OtherPlex`: "Leaving out what you have already watched needs your
      Plex account: ask the owner: `/apmedia account @you <plex name>`. Or build the list with
      `unwatched:false`." Then `/apmedia yaml name:Zoë unwatched:False`: attached as `Zoë.yaml`.
      Download it and note the name Discord kept: a rewritten `ë` would let two players' files meet
      in one folder. With `unwatched:False` again, `name:Zack M.` gives `Zack_M-cd58afdb.yaml`, and
      `name:Bad{1}` answers "The name cannot contain {, } or %."
- [ ] `!apmedia yaml name=Picks movies=2 titles="<a movie title>; <a misspelt album title>"`, in a
      channel: the reply is public, the movie is in the YAML, and the album is listed under "❓ Not
      found" with a "did you mean". Friend's `/apmedia yaml name:X for:@Other`: "⛔ Only the bot
      owner can build a list for someone else."
- [ ] In `ZackPlex.yaml`, put `[Free](https://example.com) ` in front of the `"t"` value of its
      last movie, one `FriendPlex.yaml` does not list, as a hand-edited YAML could. The list's
      first titles start open, and a title on both lists is named from Friend's file.
- [ ] Put `ZackPlex.yaml`, `FriendPlex.yaml` and a ChecksFinder YAML named `Finder` in a folder of
      their own and generate it twice (`ArchipelagoGenerate.exe --player_files_path <folder>`):
      seeds A and B, two seeds with the same slot names. Generate seed C from a folder of two
      ChecksFinder YAMLs named `Finder` and `ZackPlex`. No generation logs a Plex Media error.
      Host A: `ArchipelagoServer.exe --port 38281 <A's AP_*.zip>`.

**Linking, and the welcome**

- [ ] In a test channel, `!ap watch localhost:38281 Finder`. The reply names the watch's id (N),
      and the watch connects, with joins and parts shown (on by default for a new watch).
- [ ] Friend: `/apmedia link slot:FriendPlex watch:N` before claiming it: "Claim the slot first:
      `!ap claim N FriendPlex` shows it is yours. Then link it again, or ask the bot owner to link
      it for you." Friend runs `!ap claim N FriendPlex` and links again: "🔗 Linked `FriendPlex` on
      watch #N.", with no warning.
- [ ] You: `/apmedia link slot:zackplex watch:N`, in lower case: "🔗 Linked `ZackPlex` on watch
      #N.", in the room's spelling.
- [ ] Within seconds the test channel has one welcome per slot: "🎬 `ZackPlex` is in the game with
      N of M titles open: <up to 8 titles, each with its runtime>. Goal: finish K.", then "Plex
      account: the server owner (account 1).", then the `!ap claim N ZackPlex` and `!ap hintpings
      N ZackPlex dm` commands. FriendPlex's says "Plex account: linked." and names no account. No
      join or leave line naming `PlexMediaBot` posts.
- [ ] `!diag`: `✓ ApMedia: 2 slots, 2 connected, Plex history read Nm ago` once the first read is
      in. Your `/apmedia status` shows both slots, FriendPlex's block naming Friend; Friend's shows
      only FriendPlex. Other's: "No Plex Media slot is linked." and how to claim and link one.
- [ ] `!restart`: no join or leave line naming `PlexMediaBot`, before or after, and no refusal in
      the bot log. Connect Archipelago's Text Client to `FriendPlex` and close it again: both its
      join and its leave lines post.
- [ ] The movie edited to carry a link: `/apmedia list show:locked` shows
      `[Free](https://example.com) <title>` as typed, brackets and all, so its words do not stand
      in for a link (Discord still makes the address itself one). In the ArchipelagoServer window,
      give its full name: `/hint ZackPlex [Free](https://example.com) <title> (<year>)`.
      `!ap hints N` lists the hint with the movie's name shown the same way.

**Watching in Plex**

- [ ] Set "Announcements" to "Every check". As the owner, play an open movie from ZackPlex's list
      (`/apmedia list` shows them) in a Plex app. Within about 15 s the bot log has `Plex Media:
      Plex sessions of account 1 are matched by User.id.` or `by User.title.`; note which.
- [ ] At 15:00 into the movie, within about 20 s plus the batch window: "⏱️ `ZackPlex` **<Title
      (Year)>**: 1 check sent", and seed A's window logs the location as found. `/apmedia status`:
      "Last Plex session: **<Title (Year)>**, reached N%: Plex counts a watch at 90%."
- [ ] Pause 5 to 10 s after passing 30:00 and wait: the 30:00 line still posts, within about 20 s
      plus the batch window. While paused, drag the playhead 5 minutes on, wait 30 s, then resume:
      nothing for the minutes dragged over.
- [ ] Seek 30 minutes forward: nothing for the minutes skipped; the checkpoints after the new
      place count again as they play.
- [ ] Play on past 90%, or to the end: within 2 minutes (`apMediaHistorySeconds`) "✅ `ZackPlex`
      watched **<Title (Year)>**, N checks sent", N covering the watch and every checkpoint not
      sent yet, and `npm run logs -- --raw` has an `apmedia-credit` event with `source` `history`.
- [ ] An episode of the show on the list, the same way: a checkpoint every 10 minutes, and the
      episode's watch at its end.

**Locked titles, unlocks and Wild Tickets**

- [ ] Watch a title from `/apmedia list show:locked` (or `/apmedia check` it): "🔒 `ZackPlex`
      watched **<Title>**, N checks waiting for its unlock". `/apmedia status` counts them as
      banked, and seed A's window logs nothing for them.
- [ ] In seed A's window, `/send ZackPlex <its unlock>`, named as `/apmedia list show:locked` says
      opens it (a movie's unlock is its title and year, such as `The Matrix (1999)`). Within
      seconds: "🔓 `ZackPlex` **<Title>** unlocked, N checks sent", and status counts none banked.
- [ ] `/send ZackPlex Wild Ticket`, then `/apmedia redeem title:<a locked title>`: "🎟️ Spent a
      Wild Ticket on **<Title>**. 0 tickets left.", and the title moves to ready. The same title
      again: "**<Title>** is open already." Another locked title, with every ticket spent:
      "`ZackPlex` has no Wild Ticket to spend (N received, N used)."
- [ ] Friend's `/apmedia redeem title:<any title> slot:ZackPlex` and `/apmedia check
      title:<any title> slot:ZackPlex`: "No linked Plex Media slot is called `ZackPlex`." Your
      `/apmedia check` on `slot:FriendPlex` works.

**Listening through the bot.** Do not `!seek` in a track that should count: a seek splits the
listen, and each part has to reach 85% alone for the track itself.

- [ ] In a voice channel, `!album <an open album from ZackPlex's list>`. After the first track
      ends: "⏱️ `ZackPlex` **<Artist - Album>**: N checks sent", the track and any 5-minute album
      checkpoint inside it. `!skip` the second a little after the album passes its next 5-minute
      mark (`/apmedia status` and the track lengths tell where): "⏱️ … 1 check sent" for that
      checkpoint, and nothing for the track. Play every track through, the skipped one again
      included: when the last one counts, "✅ `ZackPlex` listened to **<Artist - Album>**, N checks
      sent".
- [ ] Have Friend start a track while you are out of the channel and join halfway: that track
      earns you nothing, and the next one, heard from start to end, counts.
- [ ] `/config` → AP Media → "Count music heard in voice" off: the next track earns nothing. Turn
      it back on.
- [ ] `/book play <the audiobook on ZackPlex's list>` and listen past 5:00 (the list's 5-minute
      timer): "⏱️ `ZackPlex` **<Title by Author>**: 1 check sent" within about 15 s.
- [ ] `/book pause` a second or two after passing 10:00: the 10:00 line still posts, within about
      10 s of the pause. `/book resume`.
- [ ] Without pausing again, `!restart` within 5 s of passing 15:00 (`/book goto 14:50` gets there
      sooner). The bot log has `Audiobook session … ended (shutdown)`, and the 15:00 line posts
      after the restart, once `ZackPlex` has reconnected. Its `apmedia-credit` event
      (`npm run logs -- --raw`) has `banked` 1 when the shutdown closed the last stretch of
      listening, and `sent` 1 when a 10-second poll caught it first: then `/book play` and try
      again at 20:00.
- [ ] `/book play`, with no title, resumes the book. `/book goto` past the next checkpoint: nothing
      for the stretch jumped. Then `/book goto` to a minute before the end and let it play out (or
      `/book finish`): within about a minute, "✅ `ZackPlex` finished **<Title by Author>**, N
      checks sent".

**Plex history arriving late**

- [ ] In Plexamp on a phone, download an open album from ZackPlex's list, switch to airplane mode
      and play two of its tracks through. Some hours later (Plexamp has been seen syncing up to 54
      h late, and each history read covers 7 days), go back online: within a few minutes of the
      sync, `npm run logs -- --raw` has an `apmedia-credit` event with `source` `history` for each
      track, and the channel has their ⏱️ lines.

**By hand, and naming titles**

- [ ] `/apmedia check title:<an open movie not watched yet> at:45m`: "✅ **<Title (Year)>**: 3 checks
      sent." (15m, 30m and 45m). The same again: "Nothing new: **<Title (Year)>**'s checks up to
      there were counted already."
- [ ] `!apmedia check <part of a longer title, found in no other list title>`: "Did you mean
      **<Title (Year)>**? Type its title in full, or give its code: `<code>`.", and `/apmedia
      status` shows nothing new. Pick a part such as `Wars` for Star Wars (1977): `Matrix` names The
      Matrix (1999) in full, less its year and article. `!apmedia check <the same title in lower
      case, without its year>` counts it.
- [ ] `!apmedia check <another open movie> at 20`: its 15m checkpoint only, a bare number being
      minutes. If the list holds a title with "at" and a number in it (Murder at 1600), checking
      that title counts the film itself.
- [ ] `/apmedia check title:<about 300 characters of words from list titles>`: "Nothing on
      `ZackPlex`'s list matches …" at once, with no "Did you mean", and voice playing at the time
      does not stutter.

**Pages and hints**

- [ ] `!apmedia list locked` in a channel (public, unlike `/apmedia list`) with more than 22 locked
      titles: "Page 1 of N" and ◀ ▶. Friend presses ▶: a private "Only the person who asked can
      turn these pages." You press ▶: the same message turns to page 2, and no new message posts.
- [ ] Leave it untouched for over 30 minutes and press ▶: "This list has expired. Ask for it again
      to see it as it is now." `/apmedia list show:locked` gives the same pages privately, and its
      buttons turn for you.
- [ ] In seed A's window `/option hint_cost 0`, then from the Text Client connected as `ZackPlex`,
      `!hint_location Watch <an open movie's title and year>`: `/apmedia list` marks that movie
      "💡 hinted for <the slot it is for>".

**Across a restart**

- [ ] Set "Log batch (seconds)" (`archipelagoBatchSeconds`) to 60, earn a line with
      `/apmedia check`, and `!restart` within the minute: the line posts once, after the restart.
      Set it back.
- [ ] Turn "Plex Media world (/apmedia)" off: `/apmedia` answers that it is off, `!diag` says
      disabled, and seed A's window shows both game clients leave. On again: `Plex Media
      started.`, both reconnect, and no welcome posts again.

**Refusals, a new seed and a lost watch**

- [ ] Close seed A's server window and host seed C on the same port. Once the watch and the game
      clients have reconnected, the test channel gets "🔴 `ZackPlex`: the room refused its Plex
      Media client (`InvalidGame`). That slot plays another game in this room, not Plex Media:
      `/apmedia unlink` it and link the room's Plex Media slot." and "🔴 `FriendPlex`: …
      (`InvalidSlot`). The room has no slot …". `!diag`: `✗ ApMedia: 2 slots refused (ZackPlex:
      InvalidGame, FriendPlex: InvalidSlot)`.
- [ ] Close C and host A again. The refused slots stay down until `/apmedia retry`, run for each
      slot (Friend may run their own): "🔄 Reconnecting `ZackPlex`.", then both connect with no new
      welcome, and `!diag` is ✓ again.
- [ ] A second watch of the same room: `!ap watch localhost:38281 Finder` again (its id is M), then
      `/apmedia link slot:ZackPlex watch:M user:@Other`. Within seconds: "🔴 `ZackPlex`: the room
      refused its Plex Media client (`duplicate`). This seed's `ZackPlex` is linked on watch #N
      already, and only that link counts: `/apmedia unlink` this one." Your ZackPlex on watch N
      stays connected. `/apmedia unlink`, picking `ZackPlex (watch #M)` from the slot list, then
      `!ap unwatch M`.
- [ ] In seed A's window `/option password secret`, then `!restart`: the watch keeps its
      connection and the game clients reconnect, to "🔴 `ZackPlex`: … (`InvalidPassword`). The
      room's password changed: set it with `!ap password N <password>`, then `/apmedia retry`."
      `/option password none`, then `/apmedia retry` for each slot: both connect.
- [ ] `/option compatibility 0`, then `!restart`: "🔴 `ZackPlex`: … (`IncompatibleVersion`). The
      room was hosted with an exact-version compatibility setting, and the bot's client reports
      0.6.1: host it with the default compatibility, then `/apmedia retry`." `/option compatibility
      2`, then `!restart` again, with no `/apmedia retry`: both connect, and the bot log has `Plex
      Media: ZackPlex connected after its refusal.` and the same line for `FriendPlex`.
- [ ] Close A and host seed B on the same port: "🟡 `ZackPlex`: the room is on another seed now, so
      this list from the old seed no longer counts. `/apmedia retry` adopts the new seed (the old
      seed's progress does not carry over), or `/apmedia unlink` it.", for both slots, and
      nothing counts for them. `/apmedia retry` for each slot (Friend may run their own):
      "🔄 Reconnecting `ZackPlex`. It takes on the room's new seed: the old seed's progress does
      not carry over.", then a new welcome for each.
- [ ] `!ap unwatch N`: each slot posts "⚠️ `ZackPlex`: watch #N is gone, so its Plex Media client
      stopped and nothing more counts for it. …", and `!diag` shows `✗ ApMedia: 2 slots lost their
      watch (ZackPlex, FriendPlex)`. `/apmedia retry`: "Watch #N is gone: watch the room again, then
      `/apmedia unlink` and `/apmedia link` the slot on its new watch."
- [ ] Friend's `/apmedia unlink slot:FriendPlex`: "Unlinked `FriendPlex`.", plus "Its N unsent
      checks went with it." when any were waiting. Unlink ZackPlex too.
- [ ] Friend's `!apmedia account none`: "Your Plex account link is gone: its history is no longer
      read for you.", and `/apmedia account user:@Friend` (yours) says they have none. Again: "No
      Plex account is linked for you."

**The archipelago.gg upload (owner, manual)**

- [ ] Upload seed A's `AP_*.zip` at archipelago.gg and open a room. The upload is accepted, with no
      data package or checksum error, and the room page lists ZackPlex and FriendPlex playing Plex
      Media. Its tracker names ZackPlex's locations by title.
- [ ] Open `https://archipelago.gg/api/slot_data_tracker/<tracker>`, where `<tracker>` is the id
      at the end of the room page's tracker link. Each Plex Media slot's entry holds its titles and
      options, with no `account` or `discord` key, and neither your Discord user id nor Friend's
      appears anywhere on the page.
- [ ] `!ap watch <the room's URL> Finder`, then `/apmedia link slot:ZackPlex watch:<its id>`: the
      slot connects and posts its welcome. The relay names Plex Media items and locations by title,
      such as `The Matrix (1999)` and `Watch The Matrix (1999)`, never `Unlock 12` or `Check 40`.
- [ ] From a text client connected as `ZackPlex`, `!hint <the unlock of a locked title, as
      /apmedia list show:locked names it>`: the room answers with where that unlock is, or, while
      ZackPlex has too few hint points, "You can't afford the hint. You have N points and need at
      least M." Either reply shows the room knew the title by name; "Didn't find something that
      closely matches" would mean it did not. `!ap unwatch` the room when done.

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
- **`yaml` 2.9.1 went into `package-lock.json` on its own.** `npm install --package-lock-only
  --save-exact yaml@2.9.1` re-resolved the stale lockfile (`git diff --numstat` against the
  committed lock: 617 lines added, 500 removed), so only yaml's own three entries (20 lines) were
  kept and the rest of the lock is as stale as before: a full `npm install` in this checkout still
  re-resolves the whole tree, xml2js included. yaml has no dependencies, so it can go into
  `node_modules` alone: `npm pack yaml@2.9.1`, then `mkdir node_modules/yaml` and
  `tar -xzf yaml-2.9.1.tgz -C node_modules/yaml --strip-components=1`.
  Until it is there, an attached YAML gets "The bot cannot read YAML files yet: the owner has to
  install its yaml package (2.9.1).", and the tests that read a player's file fail, scenario H of
  `npm run test:apworld` among them; the rest of the bot runs without it.
- ~~Logs are console-only.~~ Fixed: `data/logs/` now holds both a console mirror and a structured
  command log, kept indefinitely. Read it with `npm run logs`.
- **2 of 122 unit tests fail on your machine** (`test/plexHome.test.js`) — they assert on a missing
  `homeOwnerToken` but read your real `config/plex.js`, where it's set. It's a test-isolation bug,
  not a bot bug, but it means `npm test` isn't currently a clean signal.
