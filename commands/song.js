module.exports = {
  name : 'song',
  command : {
    usage: '',
    description: 'displays current song',

    slash: {

        description: "Search the Plex library for a song",

        options: [

            { name: "query", type: "STRING", description: "Song title or artist", required: true }

        ]

    },
    process: function(bot, client, message) {
      let messageLines = '';
      if (bot.songQueue.length > 0) {
        let embedObj = bot.songToEmbedObject(bot.songQueue[0]);
        message.channel.send({ content: bot.language.BOT_PLAYSONG_SUCCES, embeds: [embedObj] });
      }
      else {
        message.reply(bot.language.VIEWQUEUE_FAIL);
      }
    }
  }
};