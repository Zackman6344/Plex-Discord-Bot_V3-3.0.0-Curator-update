'use strict';
// Bot module ------------------------------------------------------------------
const EventEmitter = require('events');
const fs = require('fs');
const ytdl = require('@distube/ytdl-core');
const config = require('../config/config');
const logger = require('../helpers/logger.js');
const commandLog = require('../helpers/commandLog.js');
const { getPlex } = require('../helpers/plexClient.js');
const playbackButtons = require('../helpers/playbackButtons.js');
const plexResolve = require('../helpers/plexResolve.js');
const seek = require('../helpers/seek.js');
const { FFmpeg } = require('prism-media');
const { Readable, pipeline } = require('stream');
const {
	NoSubscriberBehavior,
	StreamType,
	createAudioPlayer,
	createAudioResource,
	entersState,
	AudioPlayerStatus,
	VoiceConnectionStatus,
	joinVoiceChannel,
	getVoiceConnection
} = require('@discordjs/voice');
const language = require('../'+config.language);
// plex constants ------------------------------------------------------------
const plexConfig = require('../config/plex');
const PLEX_PLAY_START = (plexConfig.https ? 'https://' : 'http://') + plexConfig.hostname + ':' + plexConfig.port;
const PLEX_PLAY_END = '?X-Plex-Token=' + plexConfig.token;

const maxTransmissionGap = 5000;

function getRandomNumber(max) {
	return Math.floor(Math.random() * Math.floor(max));
}

class Bot extends EventEmitter{
		constructor(client){
				super();
				this.client = client;

				// plex config ---------------------------------------------------------------
				this.language = language;
				this.config = config;

				// plex client — shared instance from helpers/plexClient.js so the Bot and command
				// files all hit the same connection pool.
				this.plex = getPlex();
				// plex variables ------------------------------------------------------------
				this.tracks = null;
				this.plexQuery = null;
				this.plexOffset = 0; // default offset of 0
				this.plexPageSize = 10; // default result size of 10
				this.isPlaying = false;
				this.isPaused = false;
				this.songQueue = []; // will be used for queueing songs
				this.volume = 0.2
				this.botPlaylist = null;

				// plex vars for playing audio -----------------------------------------------
				this.dispatcher = null;
				this.voiceChannel = null;
				this.conn = null;
				this.cache_library = {};
				
				this.workingTask = 0;
				this.waitForStart = false;
				this.waitForStartMessage = null;
				this.playRun = 0;
				this.stopGeneration = 0;
				this.stoppedEntry = null;
		}
	/**
	 * Work like a simple semaphore to avoid conflict while playing song.
	 */
	beginWorking() {
		this.workingTask++;
	}

	/**
	 *
	 */
	endWorking() {
		this.workingTask--;
		if(this.workingTask == 0 && this.waitForStart) {
			this.waitForStart = false;
			this.playSong(this.waitForStartMessage);
		}
	}

	async findRandomTracksOnPlex(message) {
		if(Object.keys(this.cache_library).length == 0){
			await this.loadLibrary();
		}
		const nombre = getRandomNumber(Object.keys(this.cache_library).length);
		const res = await this.plex.query('/library/sections/' + this.cache_library[Object.keys(this.cache_library)[nombre]].key + '/all?type=10');
		const nombre2 = getRandomNumber(res.MediaContainer.Metadata.length);
		const music = this.trackToMusic(res.MediaContainer.Metadata[nombre2]);
		this.songQueue.push(music);
		if(!this.isPlaying){
			this.playSong(message);
		} else {
			message.reply(language.BOT_ADDTOQUEUE_SUCCES.format({artist : music.artist, title : music.title}));
		}
	}

	/**
	 * Find song when provided with query string, offset, pagesize, and message
	 */
	async findTracksOnPlex(query, offset, pageSize, type = 10) {
		const queryHTTP = encodeURI(query);
		return await this.plex.query('/search/?type=' + type + '&query=' + queryHTTP + '&X-Plex-Container-Start=' + offset + '&X-Plex-Container-Size=' + pageSize);
	}

	/**
	 *
	 */
	async loadMood(id) {
		const res = await this.plex.query('/library/sections/' + id + '/mood?type=10');
		const moods = {};
		if(res.MediaContainer.Directory) {
			for(let mood of res.MediaContainer.Directory) {
				moods[mood.title] = {name: mood.title, key : mood.key, url : '/library/sections/' + id + '/all?type=10&mood=' + mood.key};
			}
		}
		return (Object.keys(moods).length === 0 && moods.constructor == Object ? undefined : moods);
	}

	/**
	 *
	 */
	async loadLibrary(id=-1) {
		try {
			if(id == -1) {
			this.cache_library = {};
			const res = await this.plex.query('/library/sections');
			for(let library of res.MediaContainer.Directory){
				if(library.type == 'artist'){
					this.cache_library[library.key] = {name: library.title, key : library.key, mood : await this.loadMood(library.key)};
					this.emit('libraryAdded', this.cache_library[library.key]);
				}
			}
			
		} else {
			const res = await this.plex.query('/library/sections/' + id);
			if(!res.MediaContainer.title1) {
				this.emit('loadLibraryError', {key: id, err: new Error('Key doesn\'t exist.')});
				return;
			}
			this.cache_library[id] = {name: res.MediaContainer.title1, key: id, mood: await this.loadMood(id)};
			this.emit('libraryAdded', this.cache_library[id]);
		}
		} catch(err) {
			this.emit('loadLibraryError', {key: id, err: err});
		}
	}

	async removeLibrary(id=-1) {
		if(id == -1) {
			;
		} else {
			const library = this.cache_library[id];
			delete this.cache_library[id];
			this.emit('libraryRemoved', library);
		}
	}

	/**
	 *
	 */
	async findArtist(name, message) {
		// Artist : type = 8
		const resArtist = await this.findTracksOnPlex(name, 0, 10, 8);
		const resAlbums = await this.plex.query(resArtist.MediaContainer.Metadata[0].key);
		for(let album of resAlbums.MediaContainer.Metadata) {
			const resTracks = await this.plex.query(album.key);
			for(let track of resTracks.MediaContainer.Metadata) {
				const music = this.trackToMusic(track);
				this.songQueue.push(music);
			}
		}
		message.reply('add ' + name + '\'s albums to the queue.');
		if(!this.isPlaying) {
			this.playSong(message);
		}
	}

	/**
	 *
	 */
	async playOneMood(moodName, message){
		if(Object.keys(this.cache_library).length == 0){
			await this.loadLibrary();
		}
		const musics = [];
		for (let library of Object.values(this.cache_library)){
			if(library.mood[moodName]) {
				const res = await this.plex.query(library.mood[moodName].url)
				for(let track of res.MediaContainer.Metadata){
					musics.push(this.trackToMusic(track));
				}
			}
		}
		if(musics.length > 0) {
			const musicChosen = musics[Math.floor(Math.random() * Math.floor(musics.length))];
			this.songQueue.push(musicChosen);
			if(!this.isPlaying){
				this.playSong(message);
			} else {
				message.reply(language.BOT_ADDTOQUEUE_SUCCES.format({artist : musicChosen.artist, title : musicChosen.title}));
			}
		} else {
			message.reply('I cannot find the mood you\'re looking for :cry:.');
			throw 'mood missing'
		}
	}

	
	/**
	 *
	 */
	trackToMusic(track) {
		const key = track.Media[0].Part[0].key;
		let artist = '';
		const title = track.title;
		if ('originalTitle' in track) {
			artist = track.originalTitle;
		}
		else {
			artist = track.grandparentTitle;
		}
		const album = track.parentTitle;
		return {'artist' : artist, 'title': title, 'key': key, 'album': album};
	};

	/**
	 *
	 */
	async findOneSongOnPlex(query) {
		const res = await this.findTracksOnPlex(query, 0, 1, 10);
		
		const liste = res.MediaContainer.Metadata;
		const taille = res.MediaContainer.size;
		if (taille < 1) {
				throw new Error('The song was not found.');
		}
		return this.trackToMusic(liste[0]);
	};

	async listPlaylist(message) {
		const res = await this.plex.query('/playlists?playlistType=audio' + '&X-Plex-Container-Start=' + 0 + '&X-Plex-Container-Size=' + 100);
		if(res.MediaContainer.Metadata === undefined || res.MediaContainer.Metadata.length === 0) {
			throw new Error("Playlist not find");
		}

		return res.MediaContainer.Metadata;
	}

	async findPlaylist(query, message, random) {
		const queryHTTP = encodeURI(query);
		const res = await this.plex.query('/playlists?playlistType=audio' + '&title=' + queryHTTP + '&X-Plex-Container-Start=' + 0 + '&X-Plex-Container-Size=' + 100);

		if(res.MediaContainer.Metadata === undefined || res.MediaContainer.Metadata.length === 0) {
			throw new Error("Playlist not find");
		}
		for (const entry of res.MediaContainer.Metadata) {
			if (entry.title.toLowerCase().includes(query.toLowerCase())) {
				this.loadPlaylist(entry.key, message, random);
				message.reply(`The playlist "${entry.title}" has been loaded.`);
				return ;
			}
		}
		
		
	}

	/**
	 *
	 */
	async loadPlaylist(key, message, random=false) {
		try {
			const res = await this.plex.query(key);
			const tracks = res.MediaContainer.Metadata || [];

			for (const track of tracks) {
				this.songQueue.push(this.trackToMusic(track));
			}

			if (random) {
				let h = 0;
				if (this.isPlaying)
					h = 1;

				for(let i = h; i < this.songQueue.length; i++) {
					const j = getRandomNumber(this.songQueue.length -1) + h;
					const inter = this.songQueue[j];
					this.songQueue[j] = this.songQueue[i];
					this.songQueue[i] = inter;
				}
			}

			if(!this.isPlaying) {
				this.playSong(message);
			}
		} catch (err) {
			logger.error('loadPlaylist failed:', err);
		}
	}

	/**
	 *
	 */
	async findAlbum(query, message) {
		// Album : type = 9
		const res = await this.findTracksOnPlex(query, 0, 10, 9);
		try {
			const key = res.MediaContainer.Metadata[0].key;
			this.loadAlbum(key, message);
		} catch (err) {
			throw new Error('The album was not found.');
		}
	}

	/**
	 *
	 */
	async loadAlbum(key, message) {
		try {
			const res = await this.plex.query(key);
			const tracks = res.MediaContainer.Metadata || [];

			for (const track of tracks) {
				this.songQueue.push(this.trackToMusic(track));
			}

			if(!this.isPlaying) {
				this.playSong(message);
			}
		} catch (err) {
			logger.error('loadAlbum failed:', err);
		}
	}

	/**
	 *
	 */
	async findSong(query, offset, pageSize, message) {
		try {
			const res = await this.findTracksOnPlex(query, offset, pageSize);
			this.tracks = res.MediaContainer.Metadata;

			const resultSize = res.MediaContainer.size;
			this.plexQuery = query; // set query for !nextpage
			this.plexOffset = this.plexOffset + resultSize; // set paging

			let messageLines = '\n';
			let artist = '';
			if (resultSize == 1 && offset == 0) {
				// songKey = 0;
				// add song to queue
				this.addToQueue(0, this.tracks, message);
			}
			else if (resultSize > 1) {
				for (let t = 0; t < this.tracks.length; t++) {
					if ('originalTitle' in this.tracks[t]) {
						artist = this.tracks[t].originalTitle;
					}
					else {
						artist = this.tracks[t].grandparentTitle;
					}
					messageLines += language.BOT_FIND_SONG_INFO_MUSIC.format({index : t+1, artist : artist, title : this.tracks[t].title}) + '\n';
				}
				messageLines += language.BOT_FIND_SONG_INFO.format({commandPrefix: this.config.commandPrefix});
				message.reply(messageLines);
			}
			else {
				message.reply(language.BOT_FIND_SONG_ERROR);
			}
		} catch(err) {
			logger.error('findSong failed:', err);
		};
	}

	/**
	 *
	 */
	addToQueue(songNumber, tracks, message) {
		if (songNumber > -1){
			let key = tracks[songNumber].Media[0].Part[0].key;
			let artist = '';
			let title = tracks[songNumber].title;
			const album = tracks[songNumber].parentTitle;
			if ('originalTitle' in tracks[songNumber]) {
				artist = tracks[songNumber].originalTitle;
			}
			else {
				artist = tracks[songNumber].grandparentTitle;
			}

			this.songQueue.push({'artist' : artist, 'title': title, 'album': album, 'key': key});
			if (!this.isPlaying) {
				this.playSong(message)
			} else {
				message.reply(language.BOT_ADDTOQUEUE_SUCCES.format({artist : artist, title : title}));
			}

		}
		else {
			message.reply(language.BOT_ADDTOQUEUE_FAIL);
		}
	}

	/**
	 * Fetch a track's audio from Plex, repairing a dead key if that is what went wrong.
	 *
	 * `fetch` does not throw on 404, and Plex answers a dead part key with an HTML error page,
	 * so without the `ok` check that page became the audio stream: it ended instantly, the player
	 * went Idle, and the queue advanced. A 47-track playlist drained in about ten seconds with
	 * nothing logged anywhere, because nothing had failed in a way JavaScript noticed.
	 *
	 * A key dies whenever the file behind it moves, which a re-scan or a drive changing letter
	 * both do. The title and artist are the durable half of a saved track, so a 404 is treated as
	 * "look it up again" rather than as "gone".
	 *
	 * @returns {Promise<Response|null>} a response with a real body, or null when the track
	 *   cannot be played and the user has been told
	 */
	async openPlexStream(track, message) {
		const attempt = async (key) => {
			try {
				const res = await fetch(PLEX_PLAY_START + key + PLEX_PLAY_END);
				return res.ok ? res : { failed: true, status: res.status };
			} catch (err) {
				return { failed: true, status: (err && err.message) || 'network error' };
			}
		};

		const first = await attempt(track.key);
		if (!first.failed) return first;

		logger.warn(`Plex refused "${track.title}" (${first.status}); looking the track up again`);
		const found = await plexResolve.resolveKey(this, track);
		if (found && found.key && found.key !== track.key) {
			const second = await attempt(found.key);
			if (!second.failed) {
				// Kept on the queue entry so a replay of this track uses the working key too.
				track.key = found.key;
				commandLog.recordEvent('track-key-repaired', {
					title: track.title, artist: track.artist, playlist: track.playlist || null
				});
				logger.info(`Repaired the Plex key for "${track.title}"`);
				// Saved back where it came from, so the search is paid once rather than on every
				// play. Failure here is not worth interrupting playback for.
				if (track.playlist) {
					plexResolve.persistKey(this.config.playlistsDir, track.playlist, track, found.key)
						.then(saved => { if (saved) logger.info(`Updated ${track.playlist}.playlist with the new key`); })
						.catch(() => {});
				}
				return second;
			}
		}

		this.noteUnplayable(track, first.status, message);
		return null;
	}

	/**
	 * Report a track that cannot be played, without turning a broken library into 47 messages.
	 *
	 * The first few say what happened, because one bad track in a good playlist is worth naming.
	 * Past that the channel learns nothing from repetition, so the rest are counted and reported
	 * once when playback stops.
	 */
	noteUnplayable(track, status, message) {
		if (!this.unplayable) this.unplayable = [];
		this.unplayable.push({ title: track.title, artist: track.artist, status });
		commandLog.recordEvent('track-unplayable', {
			title: track.title, artist: track.artist, status, playlist: track.playlist || null
		});
		logger.warn(`Could not play "${track.title}" by ${track.artist}: Plex said ${status}`);

		if (this.unplayable.length <= 3 && message && message.channel) {
			const label = track.title ? `**${track.title}**` : 'a track';
			message.channel.send(
				`⚠️ Could not fetch ${label} from Plex (${status}). Skipping.`
			).catch(() => {});
		}
	}

	/** Advance past a track that could not be fetched, ending playback if it was the last one. */
	skipUnplayable(message) {
		this.songQueue.shift();
		if (this.songQueue.length > 0) {
			this.playSong(message);
			return;
		}
		this.isPlaying = false;
		this.reportUnplayable(message);
		this.emit('finish', message);
		this.playbackCompletion(message);
	}

	/** One summary for everything that was skipped, once the queue is done. */
	reportUnplayable(message) {
		const skipped = this.unplayable || [];
		this.unplayable = [];
		if (skipped.length <= 3 || !message || !message.channel) return;

		const statuses = [...new Set(skipped.map(s => s.status))].join(', ');
		message.channel.send(
			`⚠️ ${skipped.length} tracks could not be fetched from Plex (${statuses}). ` +
			`That usually means the files have moved and the library needs a re-scan.`
		).catch(() => {});
	}

	/**
	 * Where the next track should play.
	 *
	 * Stay in the channel we are already connected to — queueing a song shouldn't drag the bot
	 * across channels mid-playlist — but only while that connection is actually alive. The old
	 * code cached `voiceChannel` and only ever re-read it when null, so a channel the bot had
	 * since been dropped from was reused forever, and the "are you in a voice channel?" check was
	 * skipped because the cached value was still truthy.
	 */
	pickVoiceChannel(message) {
		const status = this.conn && this.conn.state && this.conn.state.status;
		const live = status === VoiceConnectionStatus.Ready
			|| status === VoiceConnectionStatus.Signalling
			|| status === VoiceConnectionStatus.Connecting;
		if (live && this.voiceChannel) return this.voiceChannel;

		// `member.voice` is always a VoiceState in discord.js v14 — never null — so the channel
		// itself is what says whether they're actually in one.
		const fromMember = message && message.member && message.member.voice
			? message.member.voice.channel
			: null;
		return fromMember || null;
	}

	/**
	 * Join `this.voiceChannel`, first destroying any connection for the guild that is not Ready,
	 * an earlier run's unfinished join included.
	 *
	 * joinVoiceChannel hands back an existing connection for the guild as-is. If that one is
	 * disconnected or destroyed it never reaches Ready, so entersState waits the full timeout and
	 * then aborts — the AbortError that used to escape as an unhandled rejection.
	 *
	 * The channel is read once, up front: while the join waits, a newer run can replace
	 * `this.voiceChannel`, and its failure can clear it.
	 */
	async openConnection() {
		const channel = this.voiceChannel;
		const guildId = channel.guild.id;
		const existing = getVoiceConnection(guildId);
		if (existing && existing.state && existing.state.status !== VoiceConnectionStatus.Ready) {
			try { existing.destroy(); } catch (_) {}
		}

		const connection = joinVoiceChannel({
			channelId: channel.id,
			guildId,
			adapterCreator: channel.guild.voiceAdapterCreator
		});

		const startedAt = Date.now();
		try {
			await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
		} catch (error) {
			commandLog.recordEvent('voice-join-failed', {
				channel: channel.name,
				channelId: channel.id,
				replacedDeadConnection: !!existing,
				waitedMs: Date.now() - startedAt,
				error: (error && error.message) || String(error)
			});
			try { connection.destroy(); } catch (_) {}
			throw error;
		}
		commandLog.recordEvent('voice-joined', {
			channel: channel.name,
			channelId: channel.id,
			replacedDeadConnection: !!existing,
			tookMs: Date.now() - startedAt
		});
		return connection;
	}

	/**
	 * Put playback back to a state the next command can recover from.
	 *
	 * The queue is deliberately kept: the tracks are still what the user asked for. What has to go
	 * is the belief that we are playing them — `isPlaying` left true meant every later `!play`
	 * just queued silently and nothing ever started, which is what "the bot stopped responding"
	 * actually was.
	 */
	failPlayback(message, error) {
		logger.error('Playback could not start:', (error && error.stack) || error);
		commandLog.recordEvent('playback-failed', {
			channel: this.voiceChannel && this.voiceChannel.name,
			channelId: this.voiceChannel && this.voiceChannel.id,
			queueDepth: this.songQueue.length,
			error: (error && error.message) || String(error)
		});

		this.isPlaying = false;
		this.waitForStart = false;
		this.waitForStartMessage = null;
		this.voiceChannel = null;
		if (this.conn) {
			try { this.conn.destroy(); } catch (_) {}
			this.conn = null;
		}

		if (message && message.channel && typeof message.channel.send === 'function') {
			const queued = this.songQueue.length;
			message.channel.send(
				`⚠️ I couldn't get into the voice channel, so playback stopped.` +
				(queued ? ` ${queued} track${queued === 1 ? '' : 's'} are still queued — join a channel and run \`${this.config.commandPrefix}play\` to pick up where this left off.` : '')
			).catch(() => {});
		}
	}

	stop() {
		// A runPlayback still waiting on the join or the download has no player yet for this to
		// stop, so it checks these once the wait is over.
		this.stopGeneration++;
		this.stoppedEntry = this.songQueue[0];
		// With nothing left to play, playback is over now rather than when the stopped player goes
		// Idle. A player still buffering gets there only once ffmpeg's output turns readable or its
		// download fails, seconds later behind a deep seek, and until then a !play only queued its
		// track, which that late Idle then ended as if it had played.
		if (this.songQueue.length === 0) this.isPlaying = false;
		// destroy() (not disconnect()) so discord.js drops the connection from its
		// per-guild registry. A disconnect()-ed connection lingers in a half-dead
		// state; the next joinVoiceChannel returns that corpse, entersState(Ready)
		// waits 30s, then aborts with an AbortError that surfaces as an unhandled
		// rejection. Nulling this.conn forces a fresh connection next play.
		if (this.conn) {
			try { this.conn.destroy(); } catch (_) {}
			this.conn = null;
		}
		// The next track gets a player of its own, which starts unpaused.
		this.isPaused = false;
		if (this.dispatcher) {
			// A paused player ignores an unforced stop until it is unpaused, so the queue waited for
			// !resume. Unpaused first, it goes Idle in its own time like a playing one. Not forced:
			// that goes Idle inside this call and starts the next track, and a second stop straight
			// after, which !hitster stop makes, then stopped that track too. The unpause emits
			// Playing again, which runPlayback's listener ignores after a player's first.
			try {
				if (this.dispatcher.state.status === AudioPlayerStatus.Paused) this.dispatcher.unpause();
				this.dispatcher.stop();
			} catch (_) {}
		}
	}

	/**
	 * The audio for a Plex track started `ms` in.
	 *
	 * createAudioResource spawns its own ffmpeg for a plain stream and takes no extra arguments,
	 * so a seek brings an ffmpeg that already outputs Ogg/Opus and voice only demuxes it. With
	 * ffmpeg-static, which has libopus, that is also how normal tracks are encoded.
	 *
	 * `pipeline` so a download failing mid-track ends the track at once, as voice's own pipeline
	 * does for a normal track. Its callback is empty because every stop ends it with a premature
	 * close, and readstream's own listener already logs a failed download.
	 *
	 * prism kills ffmpeg only while its stdin is open, so a stop after the whole download has gone
	 * in would leave it blocked writing to a stdout nobody reads.
	 */
	seekResource(readstream, ms) {
		const seeker = new FFmpeg({ args: seek.seekArgs(ms) });
		pipeline(readstream, seeker, () => {});
		const resource = createAudioResource(seeker, { inputType: StreamType.OggOpus });
		resource.playStream.once('close', () => {
			if (seeker.process) seeker.process.kill('SIGKILL');
		});
		return resource;
	}
	/**
	 *
	 */
	/**
	 * Start (or continue) playback. Never rejects: every caller is fire-and-forget — queue
	 * advances, timers, command handlers — so a throw here became an unhandled rejection that
	 * left `isPlaying` stuck true and the bot accepting commands while playing nothing.
	 */
	async playSong(message) {
		try {
			await this.runPlayback(message);
		} catch (error) {
			this.failPlayback(message, error);
		}
	}

	async runPlayback(message) {

		if (message == null || message.member == null) {
			if (message && message.channel) {
				message.channel.send("The bot cannot see who sent the message, and therefore cannot connect to the voice channel.");
			}
			return;
		}

		const channel = this.pickVoiceChannel(message);

		if (!channel) {
			// Nothing is playing and the requester isn't in a channel: keep the queue, drop the
			// belief that playback is under way, and say which of the two is missing.
			this.isPlaying = false;
			const queued = this.songQueue.length;
			message.channel.send(
				`🔇 Join a voice channel first — I don't know where to play this.` +
				(queued ? ` ${queued} track${queued === 1 ? '' : 's'} are waiting in the queue.` : '')
			);
			return;
		}
		// Set only once a channel is found: a run still joining relies on it to stay in its channel
		// at the next track.
		this.voiceChannel = channel;

		if (this.voiceChannel) {
			this.emit('will play', message);
			if(this.workingTask > 0){
				this.isPlaying = true;
				this.waitForStart = true;
				this.waitForStartMessage = message;
			} else {
				// Read again after each await below. A skip or stop landing in one has no player of
				// this run's to stop, and the queue or a newer run may have moved on meanwhile.
				const run = ++this.playRun;
				const generation = this.stopGeneration;
				const track = this.songQueue[0];

				let announced = false;
				// Arrow fuction to be played after a song is finished.
				let dispatcherFunc = () => {
					const next = seek.afterTrack(this.songQueue);
					if (next === 'replay') {
						// Only a track that reached Playing has been announced. One replayed before
						// that, by a seek or by a skip on a loop that never started, still needs it.
						if (announced) this.songQueue[0].played = true;
						this.playSong(message);
						return;
					}
					this.songQueue.shift();
					if (next === 'next') {
						this.playSong(message);
						return;
					}
					// no songs left in queue, continue with playback completion events
					this.isPlaying = false;
					this.reportUnplayable(message);
					this.emit('finish', message);
					this.playbackCompletion(message);
				};
				const superseded = () => {
					// A second !play before anything played, or a Hitster clip, started a run of
					// its own. Only the newest acts, or one skip would advance the queue twice.
					if (this.playRun !== run) return true;
					const head = this.songQueue[0];
					if (this.stopGeneration !== generation && head === this.stoppedEntry) {
						// The stop was meant for this entry, so the queue moves on as it would have
						// when its player went Idle. That includes a Hitster clip loading over music:
						// the stop also stopped the music's player, whose Idle leaves the queue to
						// this run. A seek still waiting on this download would turn that into a
						// replay and swallow a skip.
						seek.takeSeek(track);
						dispatcherFunc();
						return true;
					}
					if (head === track) return false;
					// The queue changed under this run: cleared or its head removed before anything
					// played, or refilled after a !stop. Carry on from what is there now.
					if (head) this.playSong(message);
					else dispatcherFunc();
					return true;
				};

				try {
					this.conn = await this.openConnection();
				} catch (error) {
					// A newer run's openConnection destroyed this run's unfinished join, which then
					// only times out. Failing here would destroy that run's connection mid-track.
					if (this.playRun !== run) return;
					throw error;
				}
				if (superseded()) return;

				let readstream;
				let seekMs = 0;
				if(this.songQueue[0].key) {
					const response = await this.openPlexStream(track, message);
					if (superseded()) {
						if (response && response.body) response.body.cancel().catch(() => {});
						return;
					}
					// Nothing playable, and the user has already been told why. Move on rather
					// than handing 85 bytes of HTML to the audio player, which is what used to
					// drain a whole playlist in ten seconds without a word in the log.
					if (!response) {
						this.skipUnplayable(message);
						return;
					}
					readstream = Readable.from(response.body, {highWaterMark: 20971520});
					seekMs = seek.takeSeek(track);
				} else {
					readstream = ytdl(this.songQueue[0].url, { format: 'audioonly', quality: config.youtube_quality || 'highestaudio' });
				}
				this.isPlaying = true;
				commandLog.recordEvent('track-start', {
					title: this.songQueue[0] && this.songQueue[0].title,
					artist: this.songQueue[0] && this.songQueue[0].artist,
					queueDepth: this.songQueue.length,
					channel: this.voiceChannel && this.voiceChannel.name,
					seekMs: seekMs || null
				});
				// 20 971 520 bits = 20Mb

				// Tear down any prior AudioPlayer + readstream before replacing them.
				// Without this, re-entry through waitForStart -> endWorking -> playSong
				// (or a forced replay) leaves the previous player subscribed with handler
				// closures pinning the ~20MB read buffer alive.
				if (this.dispatcher) {
					try { this.dispatcher.removeAllListeners(); } catch (_) {}
					try { this.dispatcher.stop(true); } catch (_) {}
				}
				// With its listeners gone, that Idle clears nothing. A Hitster clip replaces paused
				// music this way, and the player built below starts unpaused.
				this.isPaused = false;
				if (this.readstream) {
					try { this.readstream.destroy(); } catch (_) {}
				}
				this.readstream = readstream;

				// Bot.stop() stops this.dispatcher, so until a newer run replaces this player, every
				// stop from here on is a stop of this one.
				const stopsBefore = this.stopGeneration;
				const stopped = () => this.stopGeneration !== stopsBefore;
				this.dispatcher = createAudioPlayer({
					behaviors: {
						noSubscriber: NoSubscriberBehavior.Stop,
						maxMissedFrames: Math.round(maxTransmissionGap / 20),
					},
				});
				// Neither the download's 'finish' nor its 'end' may end a track. ytdl's stream, like
				// ffmpeg, emits 'finish' once the whole download has been written in, with about a
				// megabyte of audio still buffered ahead of the player: 2.5 minutes at lowestaudio.
				// 'end' comes once ffmpeg has read it all, still about 30 s before the audio runs out.
				this.dispatcher.on(AudioPlayerStatus.Idle, () => {
					readstream.destroy();
					// A paused player goes Idle too, when its stream fails or stops being readable.
					this.isPaused = false;
					// A stopped player can go Idle seconds after the stop, when the queue may no longer be
					// its own. It ends the stopped entry only while that is still the head and no newer
					// run has started. A Hitster clip loading when the stop landed acts on it in
					// superseded(), and a track queued after !stop, with a run of its own or without one
					// (a requester outside voice, !artist between album lookups), is not this player's.
					if (stopped() && (this.playRun !== run || this.songQueue[0] !== this.stoppedEntry)) return;
					dispatcherFunc()
				})
				this.dispatcher.on(AudioPlayerStatus.Playing, () => {
					// unpause() moves the player from Paused back to Playing, which emits this again.
					if (announced) return;
					// A player stopped while still buffering reaches Playing anyway once ffmpeg's output
					// turns readable, and goes Idle only after that. Announced, the stopped track, or
					// one queued since, got live controls while nothing played. Left unannounced, a
					// loop or seek replay of it is announced when it plays.
					if (stopped()) return;
					announced = true;
					const head = this.songQueue[0];
					if(head && !head.played) {
						let embedObj = this.songToEmbedObject(head);
						message.channel.send({
							content: language.BOT_PLAYSONG_SUCCES,
							embeds: [embedObj],
							components: [playbackButtons.buildRow(this)]
						});
					}
				});
				// No dispatcherFunc here. The AudioPlayer emits 'error' only for a resource whose stream
				// failed, then sets itself Idle for that resource in the same call, so the Idle handler
				// above runs it. Running it here too dropped the next track unplayed. Voice skips that
				// Idle if this handler throws or changes the player's state.
				this.dispatcher.on('error', (err) => {
					logger.error('AudioPlayer error:', err.message || err);
					try { readstream.destroy(); } catch (_) {}
					// The user already stopped this track, and the head may be one queued since, which
					// then plays.
					if (stopped()) return;
					const failed = this.songQueue[0];
					const label = failed && failed.title ? `**${failed.title}**` : 'this track';
					if (message && message.channel) {
						message.channel.send(`⚠️ Playback failed for ${label}. Skipping.`).catch(() => {});
					}
				});
				readstream.on('error', (err) => logger.error('Read stream error:', err));
				/*
				.on('start', () => {
						if(!this.songQueue[0].played) {
							let embedObj = this.songToEmbedObject(this.songQueue[0]);
							message.channel.send({ content: language.BOT_PLAYSONG_SUCCES, embeds: [embedObj] });
						}
					})
				*/
				const resource = seekMs > 0
					? this.seekResource(readstream, seekMs)
					: createAudioResource(readstream);
				this.dispatcher.play(resource, {
					inputType: StreamType.OggOpus,
				})
				this.conn.subscribe(this.dispatcher);
				
			}
		} else {
				message.reply(language.BOT_PLAYSONG_FAIL)
		}
	}

	/**
	 *
	 */
	songToEmbedObject(song) {
		const embedObj = 
			{
				color: 4251856,
				fields:
				[
					{
						name: language.TITLE,
						value: song.title,
						inline: true
					},
					{
						name: language.ARTIST,
						value: song.artist,
						inline: true
					},
				],
				footer: {
					text: language.NUMBER_MUSIC_IN_QUEUE.format({number : this.songQueue.length, plurial : (this.songQueue.length > 1 ? 's' : '')})
				},
			};
		if (song.album) {
			embedObj.fields.push(					{
				name: language.ALBUM,
				value: song.album,
				inline: true
			})
		}
		return embedObj;
	}

	/**
	 *
	 */
	async playbackCompletion(message) {
		if(!this.isPlaying) {
			if(this.conn){
					try { this.conn.destroy(); } catch (_) {}
					this.conn = null;
			}
			if(this.voiceChannel) {
					//await this.voiceChannel.leave();
					this.voiceChannel = null;
			}
		}
	}

	/**
	 *
	 */
	async addToPlaylist(playlistName, track, message) {
		const playlistFile = this.config.playlistsDir + playlistName + '.playlist';
		// On-disk playlist JSON keys (musiques/nom/titre/artiste) are intentionally left in their
		// original form to avoid breaking existing playlist files. Code-level names are English.
		fs.readFile(playlistFile, 'utf8', async (err, data) => {
			if (err){
					await message.reply(language.OPEN_PLAYLIST_ERROR);
					throw err;
			}
			const playlist = JSON.parse(data);
			playlist.musiques.push(track);
			const json = JSON.stringify(playlist);
			fs.writeFile(playlistFile, json, 'utf8', async (err, written, string) => {
					if(err) {
							await message.reply(language.WRITTING_PLAYLIST_ERROR);
							throw err;
					}
					message.reply(language.ADD_SONG_TO_PLAYLIST_SUCCES.format({title : track.titre, artist : track.artiste, playlist_name : playlist.nom}));
			});
		});
	}

	/**
	 *
	 */
	async destroy(){
		await this.playbackCompletion(null);
	}

	/**
	 *
	 */
	async getLibrariesList() {
		const res = await this.plex.query('/library/sections');
		const retour = [];
		for(let library of res.MediaContainer.Directory){
			if(library.type == 'artist'){
				retour.push({name: library.title, key: library.key, mood : await this.loadMood(library.key)});
			}
		}
		return retour;
	}
};

async function youtubeURLToMusic(youtubeURL) {
	const songInfo = await ytdl.getInfo(query);
	return {'artist' : songInfo.videoDetails.author.name , 'title': songInfo.videoDetails.title, 'url': songInfo.videoDetails.video_url};
}

module.exports = Bot;
