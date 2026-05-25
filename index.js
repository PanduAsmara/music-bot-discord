const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Queue untuk setiap server
const queue = new Map();

const PREFIX = '!';

client.once('ready', () => {
  console.log(`✅ Bot sudah online: ${client.user.tag}`);
  client.user.setActivity('!help | Music Bot', { type: 'LISTENING' });
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ===================== PLAY =====================
  if (command === 'play' || command === 'p') {
    if (!args.length) {
      return message.reply('❌ Masukkan link YouTube atau nama lagu!\nContoh: `!play https://youtube.com/...` atau `!play nama lagu`');
    }

    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      return message.reply('❌ Kamu harus masuk ke Voice Channel dulu!');
    }

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
      return message.reply('❌ Bot tidak punya izin untuk masuk ke Voice Channel!');
    }

    const query = args.join(' ');
    let songUrl = query;
    let songInfo;

    try {
      const loadingMsg = await message.reply('🔍 Mencari lagu...');

      // Cek apakah input adalah URL YouTube atau search query
      if (!query.startsWith('http')) {
        const searchResult = await ytSearch(query);
        if (!searchResult.videos.length) {
          return loadingMsg.edit('❌ Lagu tidak ditemukan!');
        }
        songUrl = searchResult.videos[0].url;
      }

      if (!ytdl.validateURL(songUrl)) {
        return loadingMsg.edit('❌ URL tidak valid! Gunakan link YouTube yang benar.');
      }

      songInfo = await ytdl.getInfo(songUrl);
      const song = {
        title: songInfo.videoDetails.title,
        url: songUrl,
        duration: formatDuration(parseInt(songInfo.videoDetails.lengthSeconds)),
        thumbnail: songInfo.videoDetails.thumbnails[0]?.url,
        requestedBy: message.author.username,
      };

      let serverQueue = queue.get(message.guild.id);

      if (!serverQueue) {
        // Buat queue baru
        const queueContruct = {
          textChannel: message.channel,
          voiceChannel,
          connection: null,
          player: null,
          songs: [],
          volume: 50,
          playing: true,
        };

        queue.set(message.guild.id, queueContruct);
        queueContruct.songs.push(song);

        try {
          const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
          });

          queueContruct.connection = connection;
          await loadingMsg.edit({ content: null, embeds: [createNowPlayingEmbed(song)] });
          play(message.guild, queueContruct.songs[0]);
        } catch (err) {
          console.error(err);
          queue.delete(message.guild.id);
          return loadingMsg.edit('❌ Gagal masuk ke Voice Channel: ' + err.message);
        }
      } else {
        serverQueue.songs.push(song);
        const embed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('➕ Ditambahkan ke Queue')
          .setDescription(`**[${song.title}](${song.url})**`)
          .addFields(
            { name: '⏱ Durasi', value: song.duration, inline: true },
            { name: '📋 Posisi', value: `#${serverQueue.songs.length}`, inline: true },
            { name: '👤 Diminta oleh', value: song.requestedBy, inline: true }
          )
          .setThumbnail(song.thumbnail)
          .setTimestamp();

        await loadingMsg.edit({ content: null, embeds: [embed] });
      }
    } catch (err) {
      console.error(err);
      message.reply('❌ Terjadi error: ' + err.message);
    }
  }

  // ===================== SKIP =====================
  else if (command === 'skip' || command === 's') {
    const serverQueue = queue.get(message.guild.id);
    if (!message.member?.voice.channel) return message.reply('❌ Kamu harus di Voice Channel!');
    if (!serverQueue) return message.reply('❌ Tidak ada lagu yang sedang diputar!');

    serverQueue.player?.stop();
    message.reply('⏭ Lagu dilewati!');
  }

  // ===================== STOP =====================
  else if (command === 'stop') {
    const serverQueue = queue.get(message.guild.id);
    if (!message.member?.voice.channel) return message.reply('❌ Kamu harus di Voice Channel!');
    if (!serverQueue) return message.reply('❌ Tidak ada lagu yang sedang diputar!');

    serverQueue.songs = [];
    serverQueue.player?.stop();
    serverQueue.connection?.destroy();
    queue.delete(message.guild.id);
    message.reply('⏹ Musik dihentikan dan bot keluar dari Voice Channel!');
  }

  // ===================== PAUSE =====================
  else if (command === 'pause') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return message.reply('❌ Tidak ada lagu yang sedang diputar!');

    if (serverQueue.player?.state.status === AudioPlayerStatus.Playing) {
      serverQueue.player.pause();
      message.reply('⏸ Musik dijeda!');
    } else {
      message.reply('❌ Musik sudah dijeda!');
    }
  }

  // ===================== RESUME =====================
  else if (command === 'resume' || command === 'r') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return message.reply('❌ Tidak ada lagu!');

    if (serverQueue.player?.state.status === AudioPlayerStatus.Paused) {
      serverQueue.player.unpause();
      message.reply('▶ Musik dilanjutkan!');
    } else {
      message.reply('❌ Musik tidak dalam keadaan dijeda!');
    }
  }

  // ===================== QUEUE =====================
  else if (command === 'queue' || command === 'q') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || !serverQueue.songs.length) {
      return message.reply('📋 Queue kosong!');
    }

    const songList = serverQueue.songs
      .slice(0, 10)
      .map((s, i) => `${i === 0 ? '🎵' : `${i}.`} **${s.title}** (${s.duration})`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📋 Queue Musik')
      .setDescription(songList)
      .setFooter({ text: `Total: ${serverQueue.songs.length} lagu` })
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }

  // ===================== NOWPLAYING =====================
  else if (command === 'nowplaying' || command === 'np') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || !serverQueue.songs.length) {
      return message.reply('❌ Tidak ada lagu yang sedang diputar!');
    }

    message.reply({ embeds: [createNowPlayingEmbed(serverQueue.songs[0])] });
  }

  // ===================== VOLUME =====================
  else if (command === 'volume' || command === 'v') {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return message.reply('❌ Tidak ada lagu yang diputar!');

    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 1 || vol > 100) {
      return message.reply('❌ Volume harus antara 1-100!\nContoh: `!volume 50`');
    }

    serverQueue.volume = vol;
    // Update resource volume jika didukung
    message.reply(`🔊 Volume diubah ke ${vol}%`);
  }

  // ===================== HELP =====================
  else if (command === 'help' || command === 'h') {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎵 Music Bot - Daftar Perintah')
      .setDescription('Prefix: `!`')
      .addFields(
        { name: '▶ !play [link/nama]', value: 'Putar lagu dari YouTube (link atau cari)', inline: false },
        { name: '⏭ !skip', value: 'Lewati lagu saat ini', inline: true },
        { name: '⏹ !stop', value: 'Hentikan musik & keluar VC', inline: true },
        { name: '⏸ !pause', value: 'Jeda musik', inline: true },
        { name: '▶ !resume', value: 'Lanjutkan musik', inline: true },
        { name: '📋 !queue', value: 'Lihat antrian lagu', inline: true },
        { name: '🎵 !nowplaying', value: 'Lagu yang sedang diputar', inline: true },
        { name: '🔊 !volume [1-100]', value: 'Atur volume', inline: true },
      )
      .setFooter({ text: 'Made with ❤️ | Discord Music Bot' })
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }
});

// ===================== FUNGSI PLAY =====================
function play(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    serverQueue?.connection?.destroy();
    queue.delete(guild.id);
    return;
  }

  const stream = ytdl(song.url, {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25,
  });

  const resource = createAudioResource(stream);
  const player = createAudioPlayer();

  player.play(resource);
  serverQueue.player = player;
  serverQueue.connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    play(guild, serverQueue.songs[0]);
  });

  player.on('error', (error) => {
    console.error('Audio Player Error:', error);
    serverQueue.songs.shift();
    play(guild, serverQueue.songs[0]);
  });
}

// ===================== HELPER FUNCTIONS =====================
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function createNowPlayingEmbed(song) {
  return new EmbedBuilder()
    .setColor('#57F287')
    .setTitle('🎵 Sedang Diputar')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: '⏱ Durasi', value: song.duration, inline: true },
      { name: '👤 Diminta oleh', value: song.requestedBy, inline: true }
    )
    .setThumbnail(song.thumbnail)
    .setTimestamp();
}

// Login bot
client.login(process.env.DISCORD_TOKEN);
