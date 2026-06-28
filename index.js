const express = require('express');
    const app = express();
    const port = process.env.PORT || 3000;

    app.get('/', (req, res) => {
        res.send('ThroveFM Bot is Streamin Live! 📻');
    });

    app.listen(port, () => {
        console.log(`[Render] Web Server dummy aktif di port ${port}`);
    });
    
    const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
    const { Connectors } = require('shoukaku');
    const { Kazagumo, Plugins } = require('kazagumo');
    const { fetch } = require('undici');
    const spotifyGet = require('spotify-url-info')(fetch);


    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    // ==================== 💡 CONFIGURATION PENGATURAN ID ====================
    const CHANNEL_MUSIK_ID = '1508464931735863487'; // Room khusus panel musik
    // ========================================================================

    const nodes = [{
        name: 'Server-Sendiri',
        url: 'GANTI_DENGAN_HOSTNAME_LAVALINK_KAMU:2333',
        auth: 'youshallnotpass',
        secure: false
    }];

    const kazagumo = new Kazagumo({
        plugins: [new Plugins.PlayerMoved(client)],
        defaultSearchEngine: 'youtube',
        send: (id, payload) => {
            const guild = client.guilds.cache.get(id);
            if (guild) guild.shard.send(payload);
        }
    }, new Connectors.DiscordJS(client), nodes); // <-- SEKARANG SUDAH SINKRON PAKAI HURUFI KECIL

    kazagumo.shoukaku.on('error', (name, error) => {
        console.error(`[Lavalink Error] Server "${name}" mengalami masalah:`, error);
    });

    function formatDurasi(ms) {
        if (!ms) return "0:00";
        const totalDetik = Math.floor(ms / 1000);
        const menit = Math.floor(totalDetik / 60);
        const sisaDetik = totalDetik % 60;
        return `${menit}:${sisaDetik < 10 ? '0' : ''}${sisaDetik}`;
    }

    const timeoutsBahuMusik = new Map();
    let pesanPanelUtama = null;

    // 💡 PANEL STANDBY COMPONENT
    const buatPanelStandby = () => {
        const embed = new EmbedBuilder()
            .setColor('#2B2D31')
            .setAuthor({ name: '💤 Player Standby', iconURL: 'https://i.imgur.com/b9t7Zun.gif' })
            .setTitle('System Standby • Idle Mode')
            .setDescription('📡 **Direct Chat Control Activated**\nNo prefixes required. Input any track title or paste a direct URL below to initialize the audio stream')
            .setFooter({ text: 'ThroveFM • No-Prefix Controller', iconURL: client.user.displayAvatarURL() });

        const rowControls = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('disabled_pause').setEmoji('⏯️').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_stop').setEmoji('⏹️').setStyle(ButtonStyle.Secondary).setDisabled(true)
        );

        const rowVolume = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('disabled_voldown').setEmoji('⬇').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_voltxt').setLabel('🔊 Vol: 5').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_volup').setEmoji('⬆').setStyle(ButtonStyle.Secondary).setDisabled(true)
        );

        return { embeds: [embed], components: [rowControls, rowVolume] };
    };

    // 💡 MASTER RENDER PANEL WITH VOLUME CONTROL & NEXT SONG UP
    const buatPanelPlayerMuter = (player) => {
        const track = player.queue.current;
        if (!track) return buatPanelStandby();

        const durasiTotal = track.length || 0;
        const totalAntrean = player.queue.length; 

        if (!player.loopMode) player.loopMode = 'none';
        if (typeof player.shuffleMode === 'undefined') player.shuffleMode = false;
        if (typeof player.skalaVolume === 'undefined') player.skalaVolume = 5; 

        let teksLoop = '`❌ Off`';
        if (player.loopMode === 'queue' && totalAntrean > 0) teksLoop = '`🔁 Loop Playlist (Semua)`';
        if (player.loopMode === 'track') teksLoop = '`🔂 Loop Track (Satu Lagu Ini)`';

        let teksNextUp = '';
        if (totalAntrean > 0) {
            const laguBerikutnya = player.queue[0];
            teksNextUp = `⏭️ **Next Up (Lagu Berikutnya):**\n` +
                        `└ **${laguBerikutnya.title}**\n` +
                        `   *Requested By: ${laguBerikutnya.requester || '@Unknown'} — \`${formatDurasi(laguBerikutnya.length)}\`*\n\n`;
        } else {
            teksNextUp = `⏭️ **Next Up (Lagu Berikutnya):**\n` +
                        `└ \`No upcoming tracks in queue\`\n\n`;
        }

        let deskripsiEmbed = teksNextUp +
                            `👤 **Requester:** ${track.requester || '@Unknown'}\n` +
                            `🔊 **Voice Channel:** <#${player.voiceId}>\n` +
                            `⏱️ **Duration:** \`${formatDurasi(durasiTotal)}\`\n` +
                            `📊 **Queue:** \`${totalAntrean} lagu tersisa\`\n` +
                            `🔁 **Loop Status:** ${teksLoop}`;

        if (totalAntrean > 0) {
            deskripsiEmbed += `\n🎲 **Shuffle Status:** ${player.shuffleMode ? '`🔀 On (Acak)`' : '`❌ Off`'}`;
        }

        const embed = new EmbedBuilder()
            .setColor(player.paused ? '#F5B041' : '#2B2D31')
            .setAuthor({ name: player.paused ? '⏸️ Music Paused' : '🎶 Now playing', iconURL: 'https://i.imgur.com/b9t7Zun.gif' })
            .setTitle(track.title)
            .setURL(track.uri || 'https://youtube.com')
            .setThumbnail(track.thumbnail || 'https://i.imgur.com/8Q5F9X8.png')
            .setDescription(deskripsiEmbed)
            .setFooter({ text: 'ThroveFM • No prefix needed! Drop your song title or link below 👇', iconURL: client.user.displayAvatarURL() });

        const daftarTombolNav = [
            new ButtonBuilder().setCustomId('btn_pause_resume').setEmoji('⏯️').setStyle(player.paused ? ButtonStyle.Success : ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary)
        ];

        let emojiLoop = '🔁';
        let warnaTombolLoop = ButtonStyle.Secondary;
        if (player.loopMode === 'queue' && totalAntrean > 0) {
            emojiLoop = '🔁';
            warnaTombolLoop = ButtonStyle.Success;
        } else if (player.loopMode === 'track') {
            emojiLoop = '🔂';
            warnaTombolLoop = ButtonStyle.Primary;
        }
        daftarTombolNav.push(new ButtonBuilder().setCustomId('btn_loop').setEmoji(emojiLoop).setStyle(warnaTombolLoop));

        if (totalAntrean > 0) {
            daftarTombolNav.push(
                new ButtonBuilder().setCustomId('btn_shuffle').setEmoji('🔀').setStyle(player.shuffleMode ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        }

        daftarTombolNav.push(new ButtonBuilder().setCustomId('btn_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger));
        const rowControls = new ActionRowBuilder().addComponents(daftarTombolNav);

        let emojiSpeaker = '🔊';
        if (player.skalaVolume === 0) emojiSpeaker = '🔇';
        else if (player.skalaVolume <= 3) emojiSpeaker = '🔈';
        else if (player.skalaVolume <= 7) emojiSpeaker = '🔉';

        const rowVolume = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_vol_down')
                .setEmoji('⬇')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(player.skalaVolume <= 0),

            new ButtonBuilder()
                .setCustomId('txt_vol_indicator')
                .setLabel(`${emojiSpeaker} Vol: ${player.skalaVolume}`)
                .setStyle(player.skalaVolume === 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setDisabled(true),

            new ButtonBuilder()
                .setCustomId('btn_vol_up')
                .setEmoji('⬆')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(player.skalaVolume >= 10)
        );

        return { embeds: [embed], components: [rowControls, rowVolume] };
    };

    // FUNGSI INTI PROSES TRACK AUDIO
    async function prosesInputLagu(guildId, textChannel, member, query) {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            const reply = await textChannel.send(`❌ <@${member.id}>, Kamu harus masuk ke voice channel terlebih dahulu!`);
            return setTimeout(() => reply.delete().catch(() => null), 5000);
        }

        if (timeoutsBahuMusik.has(guildId)) {
            clearTimeout(timeoutsBahuMusik.get(guildId));
            timeoutsBahuMusik.delete(guildId);
        }

        const isSpotify = /https?:\/\/(open|play)\.spotify\.com\/(track|playlist|album)\//i.test(query);
        let infoPesan = `🔍 Mencari \`${query}\` via Lavalink Lokal...`;
        if (isSpotify) infoPesan = `🎵 Membedah link Spotify & mencari audionya via Lavalink...`;
        
        const statusMsg = await textChannel.send(infoPesan);

        try {
            let susunanLagu = []; 
            let namaPlaylist = null;

            if (isSpotify) {
                if (query.includes('/track/')) {
                    const trackData = await spotifyGet.getData(query);
                    const namaArtis = trackData.artists ? trackData.artists.map(a => a.name).join(', ') : trackData.artist;
                    susunanLagu.push(`${namaArtis} - ${trackData.name}`);
                } 
                else if (query.includes('/playlist/') || query.includes('/album/')) {
                    const tracksData = await spotifyGet.getTracks(query);
                    try {
                        const albumData = await spotifyGet.getData(query);
                        namaPlaylist = albumData.name;
                    } catch {
                        namaPlaylist = query.includes('/playlist/') ? "Spotify Playlist" : "Spotify Album";
                    }
                    for (const track of tracksData) {
                        const namaArtis = track.artists ? track.artists.map(a => a.name).join(', ') : track.artist;
                        susunanLagu.push(`${namaArtis} - ${track.name}`);
                    }
                }
            } else {
                susunanLagu.push(query);
            }

            if (susunanLagu.length === 0) {
                await statusMsg.edit('❌ Gagal membedah struktur data link Spotify.');
                return setTimeout(() => statusMsg.delete().catch(() => null), 5000);
            }

            const player = await kazagumo.createPlayer({
                guildId: guildId,
                textId: textChannel.id,
                voiceId: voiceChannel.id,
                deaf: true
            });

            if (typeof player.skalaVolume === 'undefined') {
                player.skalaVolume = 5;
                player.setVolume(50); 
            }

            if (isSpotify && namaPlaylist) {
                await statusMsg.edit(`⏳ Sedang memasukkan lagu dari **${namaPlaylist}** ke antrean...`);
                for (const laguText of susunanLagu) {
                    const res = await kazagumo.search(laguText, { requester: member.user, engine: 'youtube' });
                    if (res && res.tracks.length > 0) player.queue.add(res.tracks[0]);
                }
                const notif = await textChannel.send(`✅ Sukses memuat **${susunanLagu.length} lagu** dari Spotify **${namaPlaylist}**!`);
                setTimeout(() => notif.delete().catch(() => null), 5000);
            } else {
                const res = await kazagumo.search(susunanLagu[0], { requester: member.user, engine: 'youtube' });
                
                if (!res || !res.tracks.length) {
                    await statusMsg.edit('❌ Audio tidak ditemukan atau gagal dikonversi.');
                    return setTimeout(() => statusMsg.delete().catch(() => null), 5000);
                }

                if (res.type === 'PLAYLIST') {
                    for (const track of res.tracks) player.queue.add(track);
                    const notif = await textChannel.send(`✅ Berhasil menambahkan Playlist **${res.playlistName}**.`);
                    setTimeout(() => notif.delete().catch(() => null), 5000);
                } else {
                    player.queue.add(res.tracks[0]);
                    const notif = await textChannel.send(`✅ Ditambahkan ke antrean: **${res.tracks[0].title}**`);
                    setTimeout(() => notif.delete().catch(() => null), 5000);
                }
            }

            if (pesanPanelUtama) {
                await pesanPanelUtama.edit(buatPanelPlayerMuter(player)).catch(() => null);
            }

            if (!player.playing && !player.paused) player.play();
            await statusMsg.delete().catch(() => null);

        } catch (err) {
            console.error("Crash report:", err);
            const errMsg = await textChannel.send('❌ Terjadi kesalahan saat memproses lagu.');
            setTimeout(() => errMsg.delete().catch(() => null), 5000);
        }
    }


    client.once('ready', async () => {
        console.log(`✅ Bot Musik Smart-Volume Room Online: ${client.user.tag}!`);
        
        // 🌟 SEETING CUSTOM STATUS UNTUK DAFTAR MEMBER (Bahasa Inggris Estetik)
        client.user.setActivity('ThroveFM Audio Stream', { type: 2 }); // Type 2 = Listening -> Listening to ThroveFM Audio Stream

        const channel = client.channels.cache.get(CHANNEL_MUSIK_ID);
        if (channel) {
            try {
                const messages = await channel.messages.fetch({ limit: 50 });
                if (messages.size > 0) await channel.bulkDelete(messages, true).catch(() => null);
                pesanPanelUtama = await channel.send(buatPanelStandby());
            } catch (e) {
                console.error("Gagal inisialisasi awal channel musik:", e);
            }
        }
    });

    // ZERO-PREFIX ENGINE
    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;
        if (message.channel.id !== CHANNEL_MUSIK_ID) return;

        const queryLagu = message.content.trim();
        await message.delete().catch(() => null);

        if (queryLagu.length > 0) {
            await prosesInputLagu(message.guild.id, message.channel, message.member, queryLagu);
        }
    });

    // INTERAKSI TOMBOL KONTROL & VOLUME MANAGEMENT
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;

        const player = kazagumo.players.get(interaction.guild.id);
        if (!player) return;

        if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== player.voiceId) {
            return interaction.reply({ content: '❌ Kamu harus berada di Voice Channel yang sama untuk mengontrol musik!', ephemeral: true });
        }

        await interaction.deferUpdate();
        if (typeof player.skalaVolume === 'undefined') player.skalaVolume = 5;

        switch (interaction.customId) {
            case 'btn_pause_resume':
                player.pause(!player.paused);
                break;
            case 'btn_skip':
                player.skip();
                break;
            case 'btn_stop':
                player.loopMode = 'none';
                player.setLoop('none');
                player.queue.clear();
                player.skip(); 
                break;
            case 'btn_loop':
                const totalAntrean = player.queue.length;
                if (totalAntrean === 0) {
                    player.loopMode = (player.loopMode === 'none') ? 'track' : 'none';
                } else {
                    if (player.loopMode === 'none') player.loopMode = 'queue';
                    else if (player.loopMode === 'queue') player.loopMode = 'track';
                    else player.loopMode = 'none';
                }
                player.setLoop(player.loopMode);
                break;
            case 'btn_shuffle':
                if (player.queue.length >= 2) {
                    player.shuffleMode = !player.shuffleMode;
                    if (player.shuffleMode) player.queue.shuffle();
                }
                break;
            case 'btn_vol_down':
                if (player.skalaVolume > 0) {
                    player.skalaVolume -= 1;
                    player.setVolume(player.skalaVolume * 10);
                }
                break;
            case 'btn_vol_up':
                if (player.skalaVolume < 10) {
                    player.skalaVolume += 1;
                    player.setVolume(player.skalaVolume * 10);
                }
                break;
        }
        
        const playerValid = kazagumo.players.get(interaction.guild.id);
        if (playerValid && playerValid.queue.current) {
            await pesanPanelUtama.edit(buatPanelPlayerMuter(playerValid)).catch(() => null);
        } else {
            await pesanPanelUtama.edit(buatPanelStandby()).catch(() => null);
        }
    });

    // ==================== KAZAGUMO MUSIC EVENTS HANDLER ====================

    kazagumo.on('playerStart', async (player, track) => {
        if (timeoutsBahuMusik.has(player.guildId)) {
            clearTimeout(timeoutsBahuMusik.get(player.guildId));
            timeoutsBahuMusik.delete(player.guildId);
        }
        if (pesanPanelUtama) await pesanPanelUtama.edit(buatPanelPlayerMuter(player)).catch(() => null);
    });

    kazagumo.on('playerEnd', async (player) => {
        setTimeout(async () => {
            if (!player.queue.current && player.queue.length === 0) {
                if (pesanPanelUtama) await pesanPanelUtama.edit(buatPanelStandby()).catch(() => null);
                
                if (!timeoutsBahuMusik.has(player.guildId)) {
                    const timerKeluar = setTimeout(async () => {
                        const playerAktif = kazagumo.players.get(player.guildId);
                        if (playerAktif) {
                            playerAktif.destroy();
                            const channel = client.channels.cache.get(player.textId);
                            if (channel) {
                                const notifMati = await channel.send('💤 *Disconnected automatically after 5 minutes of inactivity.*');
                                setTimeout(() => notifMati.delete().catch(() => null), 7000);
                            }
                        }
                        timeoutsBahuMusik.delete(player.guildId);
                    }, 300000); 

                    timeoutsBahuMusik.set(player.guildId, timerKeluar);
                }
            } else {
                if (pesanPanelUtama) await pesanPanelUtama.edit(buatPanelPlayerMuter(player)).catch(() => null);
            }
        }, 500);
    });

    kazagumo.on('playerDestroy', async (player) => {
        if (pesanPanelUtama) await pesanPanelUtama.edit(buatPanelStandby()).catch(() => null);
    });

    kazagumo.on('queueEnd', async (player) => {
        if (pesanPanelUtama) await pesanPanelUtama.edit(buatPanelStandby()).catch(() => null);
        
        const playerAktif = kazagumo.players.get(player.guildId);
        if (playerAktif && !timeoutsBahuMusik.has(player.guildId)) {
            const timerKeluar = setTimeout(async () => {
                if (kazagumo.players.get(player.guildId)) {
                    kazagumo.players.get(player.guildId).destroy();
                } else {
                    const guild = client.guilds.cache.get(player.guildId);
                    if (guild && guild.members.me.voice.channelId) guild.members.me.voice.disconnect().catch(() => null);
                }
                const channel = client.channels.cache.get(player.textId);
                if (channel) {
                    const notifMati = await channel.send('💤 *Disconnected automatically after 5 minutes of inactivity.*');
                    setTimeout(() => notifMati.delete().catch(() => null), 7000);
                }
                timeoutsBahuMusik.delete(player.guildId);
            }, 300000);

            timeoutsBahuMusik.set(player.guildId, timerKeluar);
        }
    }); 

    if (!process.env.DISCORD_TOKEN) {
        console.error('❌ DISCORD_TOKEN belum di-set! Tambahkan environment variable DISCORD_TOKEN di panel hosting kamu.');
        process.exit(1);
    }
    client.login(process.env.DISCORD_TOKEN);
