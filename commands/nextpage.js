module.exports = {
  name : 'nextpage',
  command : {
    usage: '',
    description: 'get next page of songs if desired song not listed',
    slash: {
      description: 'Show the next page of song search results'
    },
    process: function(bot, client, message, query) {
      bot.findSong(bot.plexQuery, bot.plexOffset, bot.plexPageSize, message);
    }
  }
};