# Plex Discord Bot (AI Upgrade)

> This is my personal upgrade of the [Plex Discord Bot v2](https://github.com/danxfisher/Plex-Discord-Bot) originally made by **danxfisher** and updated by **irbyk**. They get all the credit for starting this project and moving it forward — I'm just bolting on AI features, modernizing dependencies, and adding game/trivia stuff.

This bot has been "vibecoded" to speed things up, though I do know what I've changed and have an awareness of what's in here. If you don't vibe with it, use v2.

A multipurpose Discord bot designed to integrate your Plex media server with your Discord community. It handles media requests, library searching, interactive movie trivia, and high-quality music playback directly from your server.

## Requirements

- **Node.js 18 or newer.** Node 16 is EOL and the bot now uses discord.js v14, which requires 18+.
- A Discord bot token (see the V2 setup section below for how to get one).
- *(Optional)* A **Gemini API key** — required for any AI command (`!trivia`, `!curator`, `!vibe`, `!identify`, `!quest`, `!hitster`, etc.). Without it, music and basic Plex commands still work; AI commands will fail at the API call.
- *(Optional)* A running [**Tautulli**](https://tautulli.com/) instance for `!stats`.
- *(Optional)* A **Playnite HTTP server** on the host PC for `!game`, `!launch`, `!backlog`, and the gaming-history half of `!profile`.

Some features cost money to use (Gemini API beyond the free tier). Non-AI features don't. If you find the bot referencing my specific media library somewhere, open an issue so I can pull it out.

## Setup

After cloning and running `npm install`, set up your three config files. **Two of them are gitignored on purpose** so your tokens never end up in version control — copy the templates and fill them in locally:

```
cp config/keys.example.js config/keys.js
cp config/plex.example.js config/plex.js
```

(On Windows, `copy config\keys.example.js config\keys.js` etc.)

Then edit each one as below.

**`config/keys.js`** — secrets:

```js
module.exports = {
  'botToken'    : 'YOUR_DISCORD_BOT_TOKEN',
  'geminiApiKey': 'YOUR_GEMINI_API_KEY'   // leave blank to disable AI commands
};
```

**`config/plex.js`** — your Plex server. Get your token via [these instructions](https://support.plex.tv/hc/en-us/articles/204059436-Finding-an-authentication-token-X-Plex-Token). Anything in `options` can be set to whatever you want:

```js
module.exports = {
  'hostname'    : 'PLEX_LOCAL_IP_OR_HOSTNAME',
  'port'        : '32400',
  'https'       : false,
  'token'       : 'PLEX_TOKEN',
  'managedUser' : '',                       // reserved for a future feature
  'options'     : {
    'identifier': 'APP_IDENTIFIER',
    'product'   : 'APP_PRODUCT_NAME',
    'version'   : 'APP_VERSION_NUMBER',
    'deviceName': 'APP_DEVICE_NAME',
    'platform'  : 'Discord',
    'device'    : 'Discord'
  }
};
```

**`config/config.js`** — feature toggles and display:

```js
module.exports = {
  'listenChannel'   : '',                  // limit bot to one channel name; empty = listen everywhere
  'commandPrefix'   : '!',                 // command prefix character(s)
  'playlistsDir'    : 'playlists/',        // where custom user playlists are stored on disk
  'language'        : 'lang/en.js',
  'youtube_quality' : 'lowestaudio',

  'serverName'      : 'My Plex Server',    // shown in stats/help/request messages

  'ownerId'         : '',                  // your Discord user ID — gates owner-only Playnite commands and DM alerts
  'launchRoleId'    : '',                  // optional Discord role allowed to use !launch

  'playniteEnabled' : false,               // toggle Playnite integration
  'tautulliEnabled' : false,               // toggle Tautulli integration
  'tautulliApiKey'  : '',
  'tautulliUrl'     : ''                   // e.g. http://localhost:8181
};
```

Then start the bot:

```
node index.js
```

The console needs to stay open for the bot to keep running. The Docker setup in this repo uses Node 20.

## 📚 Command Directory

Type any command by itself (e.g. `!hitster`, `!playlist`) to open its specific menu.

### 🤖 AI Arcade & Minigames

- `!hitster` — Competitive turn-based music timeline game. Guess the release year!
- `!trivia` — Classic movie & TV show plot trivia.
- `!badplot` — Guess the movie from the AI's terrible, sarcastic summary.
- `!castingcouch` — Guess the project based on vague job descriptions for the actors.
- `!quotethebard` — Guess the song translated into Shakespearean English.
- `!releasesurvival` — Rapid-fire *Higher or Lower* release year survival game.
- `!rumor` — Guess the modern movie rewritten as a D&D tavern quest hook.
- `!reviewbomb` — Guess the movie based on an unhinged, petty 1-star review.
- `!survive` — Interactive text-adventure. Can you survive the movie's plot?

### 🎵 Music & Audio Controls

- `!play [song/url]` — Add a song to the queue.
- `!pause` / `!resume` / `!stop` / `!skip` — Standard playback controls.
- `!volume [1-100]` — Adjust the bot's volume.
- `!loop` / `!shuffle` — Modify how the queue plays.
- `!viewqueue` / `!clearqueue` — Manage the current playlist.
- `!song` / `!album` / `!artist` — Search Plex for specific audio.
- `!youtube [url or search]` — Play a YouTube URL, or search and play the top result.
- `!playlist` — Access the custom playlist manager (create, add, play).
- `!mood [mood]` — Random song matching your given mood.

### 🍿 Plex & Media Utilities

- `!request` — Anonymously request movies, shows, or albums for the server.
- `!curator` — Custom-tailored AI media recommendations.
- `!groupwatch` — Multiplayer curator to find a movie a group can agree on.
- `!quest` — Custom movie marathon based on a theme.
- `!identify` — Find that "tip of your tongue" movie from a vague description.
- `!vibe` — Generate a playlist or media queue based on a vibe.
- `!library` — View or search server libraries.
- `!random` — Random media pick.

### 🛠️ Owner / Admin commands

- `!diag` *(alias: `!plextest`)* — Full diagnostic: Plex, Gemini, Tautulli, Playnite. Bot also runs this every 15 minutes in the background and DMs the owner (if `ownerId` is set) on any status transition.
- `!stats` — Combined Plex (via Tautulli) + Playnite statistics.
- `!profile` — AI-generated D&D character sheet based on your gaming history.
- `!game [title]` — Search the host's game library and show metadata.
- `!launch [title]` — Boot a game on the host PC.
- `!backlog` — Random unplayed game from the library.

> Most of these are gated on `playniteEnabled` and/or `ownerId` in `config/config.js`.

## 💬 Support & Community

If you have questions about this specific version or want to see it in action, my personal Discord: <https://discord.gg/dakj4au>

If you're feeling generous, I have a Patreon — random projects (Minecraft addons, a BO3 Twitch integration tool, and this thing). 🔗 [www.patreon.com/zackman634](https://www.patreon.com/zackman634). There's a free tier; active community members or paid patrons get access to my personal Plex server.

---

<details>
<summary><b>Click here to view the original Bot Instructions and Readme from V2</b></summary>

> ⚠️ The text below is preserved from the original V2 README. A few specifics are now out of date in this fork — most notably **Node.js 16 is no longer supported (use 18+)**, the `keys.js` file now also takes a `geminiApiKey`, and the Dockerfile here uses `node:20`. The current setup is documented at the top of this README.

Original README

Note : this is a personal upgrade of the Plex Discord bot made by danxfisher available here : https://github.com/danxfisher/Plex-Discord-Bot
He should have all the credit for starting this project.

Plex Discord Bot

You need Node.js v16

Installation

Clone the repo or download a zip and unpackage it.

If you to use Docker , skip the points 2 and 3.

Install Node.js: https://nodejs.org/

Navigate to the root folder and in the console, type npm install

You should see packages beginning to install

Once this is complete, go here: https://discordapp.com/developers/applications/me

Log in or create an account

Click New App

Fill in App Name and anything else you'd like to include

Click Create App

This will provide you with your Client ID and Client Secret

Click Create Bot User

This will provide you with your bot Username and Token

Take all of the information from the page and enter it into the config/keys.js file, replacing the placeholders.

Navigate to the config/plex.js file and replace the placeholders with your Plex Server information

To get your token, following the instructions here: https://support.plex.tv/hc/en-us/articles/204059436-Finding-an-authentication-token-X-Plex-Token

The identifier, product, version, and deviceName can be anything you want

Once you have the configs set up correctly, you'll need to authorize your bot on a server you have administrative access to.  For documentation, you can read: https://discordapp.com/developers/docs/topics/oauth2#bots.  The steps are as follows:

Go to https://discordapp.com/api/oauth2/authorize?client_id=[CLIENT ID]&permissions=3197953&scope=bot where [CLIENT_ID] is the Discord App Client ID

Select Add a bot to a server and select the server to add it to

Click Authorize

You should now see your bot in your server listed as Offline.

If want want to use Docker, just go to the Docker section.

To bring your bot Online, navigate to the root of the app (where index.js is located) and in your console, type node index.js

This will start your server.  The console will need to be running for the bot to run.

If I am missing any steps, feel free to reach out or open  an issue/bug in the Issues for this repository.

Docker

If you are using Docker, you can use these commands to build and start your Plex bot (after downloading the source code and set the config file) :

go to your plex bot folder (cd your/plex/bot/folder)

docker build -t image/plexbot .

docker run -p 32400 -d --name plexbot image/plexbot

wait a few seconds and your bot should join your server and be active.
You can use docker logs plexbot to see the log of the bot (use docker logs -f plexbot if you want realtime log).

Note : you may need the sudo command/admin access depending of your user right.

Usage

Join a Discord voice channel.

Upon playing a song, the bot will join your channel and play your desired song.

Some Commands

!? : print all of the available commands.

!plexTest : a test to see make sure your Plex server is connected properly.

!clearqueue : clears all songs in queue.

!nextpage : get next page of songs if desired song is not listed.

!pause : pauses current song if one is playing.

!play <song title or artist> : bot will join voice channel and play song if one song available.  if more than one, bot will return a list to choose from.

!playsong <song number> : plays a song from the generated song list.

!removesong <song queue number> : removes song by index from the song queue.

!resume : resumes song if previously paused.

!skip : skips the current song if one is playing and plays the next song in queue if it exists.

!stop : stops song if one is playing.

!viewqueue : displays current song queue.

!playlist ? : displays all the playlist related commands.

Customization

Update the config\keys.js file with your information:

module.exports = {
  'botToken'      : 'DISCORD_BOT_TOKEN',
};


And update the config\plex.js file with your Plex information:

module.exports= {
  'hostname'    : 'PLEX_LOCAL_IP',
  'port'        : 'PLEX_LOCAL_PORT',
  'https'       : false,
  'token'       : 'PLEX_TOKEN',
  'managedUser' : 'PLEX_MANAGED_USERNAME',
  'options'     : {
    'identifier': 'APP_IDENTIFIER',
    'product'   : 'APP_PRODUCT_NAME',
    'version'   : 'APP_VERSION_NUMBER',
    'deviceName': 'APP_DEVICE_NAME',
    'platform'  : 'Discord',
    'device'    : 'Discord'
  }
};


You can find us on Discord : https://discord.gg/c39aRhB
Join it if you want to discuss or have any suggestions.

If you see any bugs use the issue tracker.  Thanks!

To Do:

????

Completed:

[x] youtube command.

[x] refactor the code base.

[x] add language support.

[x] plex mood support.

[x] plex playlist support.

[x] plex artist support.

[x] shuffle and loop support.

</details>
