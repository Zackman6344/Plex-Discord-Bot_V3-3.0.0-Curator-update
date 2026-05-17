const ytdl = require('@distube/ytdl-core');
const ytsr = require('@distube/ytsr');
const logger = require('../helpers/logger.js');

module.exports = {
  name : 'youtube',
  command : {
    usage : '<url or search>',
    description : 'play a youtube url, or search youtube and play the top result (audio only).',
    slash: {
      description: 'Play a YouTube URL or search and play the top result',
      options: [
        { name: 'query', type: 'STRING', description: 'URL or search terms', required: true }
      ]
    },
    process : async function(bot, client, message, query) {
      if (!query || !query.trim()) {
        return message.reply("Give me a YouTube URL or something to search for.");
      }

      try {
        let videoUrl;
        if (ytdl.validateURL(query)) {
          videoUrl = query;
        } else {
          const results = await ytsr(query, { limit: 5 });
          const top = results.items.find(it => it.type === 'video');
          if (!top) {
            return message.reply(`No YouTube results for "${query}".`);
          }
          videoUrl = top.url;
        }

        const songInfo = await ytdl.getInfo(videoUrl);
        bot.songQueue.push({'artist' : songInfo.videoDetails.author.name , 'title': songInfo.videoDetails.title, 'url': songInfo.videoDetails.video_url});
        if(bot.isPlaying){
          message.reply(bot.language.YOUTUBE_SUCCES.format({artist : songInfo.videoDetails.author.name, title : songInfo.videoDetails.title, commandPrefix : bot.config.commandPrefix}));
        } else {
          bot.playSong(message);
        }
      } catch (error) {
        logger.error('youtube command failed:', error);
        message.reply("Something went wrong fetching that video.");
      }

    }
  }
};
