Plex Discord Bot (AI Upgrade)

Note: This is my own personal upgrade of the Plex Discord bot (v2) originally made by danxfisher. He should have all the credit for starting this project. The v2 was updated by irbyk and should have credit for moving the project forward.

The things I've changed and updated are as follows, friends! I should mention this bot has been "vibecoded" to speed things up, though I do know what I've done and have an awareness of what I've changed. If you don't like it, I apologize, use v2.

Requirements: You'll need a Gemini API key to plug into the keys.js file. The default model is set to Gemini 2.5 Flash, and to use some of the new features you'll need to put some money in. Some features are not AI dependent, you'll have to figure them out yourselves until I can get around to better documentation. I do apologize if it references my specific media library, submit an issue request so I know.

A multipurpose Discord bot designed to integrate your Plex media server with your Discord community. It handles media requests, library searching, interactive movie trivia, and high-quality music playback directly from your server.

📚 Command Directory

🎮 Games & Trivia

!trivia - Classic movie & TV show plot trivia.

!badplot - Guess the movie from a terrible, sarcastic summary.

!castingcouch - Guess the project based on vague job descriptions for the actors.

!quotethebard - Guess the song translated into Shakespearean English.

!releasesurvival - A rapid-fire Higher or Lower release year survival game.

!rumor - Guess the modern movie rewritten as a tabletop tavern quest hook.

!reviewbomb - Guess the movie based on an unhinged, petty 1-star review.

!survive - An interactive text-adventure. Can you survive the movie's plot?

🎵 Music & Audio Controls

!play [song/url] - Add a song to the queue.

!pause / !resume / !stop / !skip - Standard playback controls.

!volume [1-100] - Adjust the bot's volume.

!loop / !shuffle - Modify how the queue plays.

!viewqueue / !clearqueue - Manage the current playlist.

!song / !album / !artist / !youtube - Search for specific audio.

!playlist - Access the custom playlist manager (create, add, play).

!mood [mood] - Provides a random song list matching your given mood.

🍿 Plex & Media Utilities

!request - Anonymously request movies, shows, or albums for the Plex server.

!curator - Get custom-tailored media recommendations.

!groupwatch - A multiplayer curator to find the perfect movie for a group to watch.

!quest - Generates a custom movie marathon based on a specific theme.

!identify - Find that "tip of your tongue" movie from a vague description.

!vibe - Generate a playlist or media queue based on a specific vibe.

!library - View or search the server's libraries.

!random - Roll the dice for a random music pick.

💬 Support & Community

If you have questions about this specific version or if you want to see it in action, my personal discord is: https://discord.gg/dakj4au

If you are feeling generous, I have a Patreon! I do random things and post there. So far I've released a couple of Minecraft addons, a BO3 Twitch integration tool (forked and fixed from someone else) and this, I suppose.
🔗 www.patreon.com/zackman634
(There's a free tier, but active members of my community or paid Patreon members get access to my personal Plex server!)

<details>
<summary><b>Click here to view the original Bot Instructions and Readme from V2</b></summary>

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
