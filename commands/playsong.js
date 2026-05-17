module.exports = {
  name : 'playsong',
  command : {
    usage: '<song number>',
    description: 'play a song from the generated song list',

    slash: {

        description: "Play a song from the last search results by number",

        options: [

            { name: "number", type: "INTEGER", description: "Song number from last search", required: true }

        ]

    },
    process: function(bot, client, message, query) {
      var songNumber = query;
      songNumber = parseInt(songNumber);
      songNumber = songNumber - 1;

      bot.addToQueue(songNumber, bot.tracks, message);
    }
  }
};