module.exports = {
  name : 'stop',
  command : {
    usage: '',
    description: 'stops playback and clears the queue',
    slash: {
      description: 'Stop playback'
    },
    process: function(bot, client, message) {
      // !stop still clears the queue. The book ends with reason 'generic', which never starts the
      // queued music (D1): only /book stop or the card's Stop hands voice over.
      if (bot.books && bot.books.routeGeneric('stop', message)) {
        bot.songQueue = [];
        return;
      }
      const wasPlaying = bot.isPlaying;
      const queued = bot.songQueue.length;
      // A queue can wait with isPlaying false: kept after a failed voice join or for a requester
      // outside voice, or still joining and downloading its first track. Gated on isPlaying, Stop
      // answered "Nothing currently playing" and kept all of it, and the next !play started from
      // the old head. bot.stop() is also what tells a run that is still loading to stand down.
      if (!wasPlaying && queued === 0) {
        message.reply(bot.language.STOP_FAIL);
        return;
      }
      bot.songQueue = []; // removes all songs from queue
      bot.stop(); // stop dispatcher from playing audio

      var embedObj = {
          color: 10813448,
          description: wasPlaying
            ? bot.language.STOP_INFO
            : bot.language.STOP_QUEUE_CLEARED.format({ number: queued, plurial: queued > 1 ? 's' : '' }),
      };
      message.channel.send({ content: bot.language.STOP_SUCCES, embeds: [embedObj] });
    }
  }
};
