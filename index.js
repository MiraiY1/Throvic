// ============================================================================
// ThroveFM — bot musik Discord (Throvic)
//
// Env yang dipakai (Render → Environment):
//   DISCORD_TOKEN        token bot
//   LAVALINK_NODES       JSON array node Lavalink v4, contoh:
//                        [{"name":"node1","url":"host.com:443","auth":"password","secure":true}]
//   MUSIC_CHANNEL_ID     (opsional) ID channel panel musik
//   MUSIC_SEARCH_ENGINE  (opsional) youtube | youtube_music | soundcloud — default youtube
//   PORT                 diisi otomatis oleh Render
// ============================================================================

const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { Connectors } = require('shoukaku');
const { Kazagumo, Plugins } = require('kazagumo');
const spotifyUrlInfo = require('spotify-url-info');

const spotifyGet = spotifyUrlInfo(globalThis.fetch);

const DEFAULT_CHANNEL_MUSIK_ID = '1508464931735863487';
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;
const BAD_NODE_COOLDOWN_MS = 30 * 60 * 1000; // node yang menolak (403 dll) diistirahatkan 30 menit

// Node publik kadang mau konek tapi menolak memutar (403). Node seperti itu dilewati sementara.
const badNodes = new Map(); // name -> sampai kapan diblok
const isBad = (name) => {
    const until = badNodes.get(name);
    if (!until) return false;
    if (Date.now() > until) { badNodes.delete(name); return false; }
    return true;
};
const markBad = (name, reason) => {
    badNodes.set(name, Date.now() + BAD_NODE_COOLDOWN_MS);
    console.warn(`[MusicBot] ⛔ Node "${name}" dilewati 30 menit: ${reason}`);
};
const nodeSiap = (nodes) => [...nodes.values()]
    .filter(n => n.state === 1 /* CONNECTED */ && !isBad(n.name))
    .sort((a, b) => a.penalties - b.penalties);

function parseNodes(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        return list
            .filter(n => n && n.url && n.auth)
            .map((n, i) => ({
                name: n.name || `node-${i + 1}`,
                url: String(n.url).replace(/^(wss?|https?):\/\//, ''),
                auth: String(n.auth),
                secure: Boolean(n.secure),
            }));
    } catch (e) {
        console.error('[MusicBot] LAVALINK_NODES bukan JSON yang valid:', e.message);
        return [];
    }
}

function formatDurasi(ms) {
    if (!ms) return '0:00';
    const totalDetik = Math.floor(ms / 1000);
    const menit = Math.floor(totalDetik / 60);
    const sisaDetik = totalDetik % 60;
    return `${menit}:${sisaDetik < 10 ? '0' : ''}${sisaDetik}`;
}

const hapusNanti = (msg, ms = 5000) => {
    if (msg) setTimeout(() => msg.delete().catch(() => null), ms);
};

function startMusicBot() {
    const token = process.env.DISCORD_TOKEN;
    const nodes = parseNodes(process.env.LAVALINK_NODES);
    const CHANNEL_MUSIK_ID = process.env.MUSIC_CHANNEL_ID || DEFAULT_CHANNEL_MUSIK_ID;
    const SEARCH_ENGINE = process.env.MUSIC_SEARCH_ENGINE || 'youtube';

    if (!token) {
        console.error('[MusicBot] DISCORD_TOKEN belum di-set! Tambahkan di Environment Render.');
        process.exit(1);
    }
    if (nodes.length === 0) {
        console.error('[MusicBot] LAVALINK_NODES kosong/invalid! Tambahkan di Environment Render.');
        process.exit(1);
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    const kazagumo = new Kazagumo({
        plugins: [new Plugins.PlayerMoved(client)],
        defaultSearchEngine: SEARCH_ENGINE,
        send: (id, payload) => {
            const guild = client.guilds.cache.get(id);
            if (guild) guild.shard.send(payload);
        },
    }, new Connectors.DiscordJS(client), nodes, {
        moveOnDisconnect: true,   // node publik sering mati → pindahkan player ke node lain
        resume: false,
        reconnectTries: 15,
        reconnectInterval: 5,     // detik (Shoukaku v4)
        restTimeout: 60,          // detik (Shoukaku v4)
        nodeResolver: (nodes) => nodeSiap(nodes)[0],
    });

    // Buat player, coba node satu per satu sampai ada yang mau.
    async function buatPlayerDenganFallback(opts) {
        const ada = kazagumo.players.get(opts.guildId);
        if (ada) return ada;
        const kandidat = nodeSiap(kazagumo.shoukaku.nodes);
        if (kandidat.length === 0) throw new Error('Tidak ada node Lavalink yang bisa dipakai saat ini');
        let errTerakhir;
        for (const node of kandidat) {
            try {
                const player = await kazagumo.createPlayer({ ...opts, nodeName: node.name });
                console.log(`[MusicBot] ▶️ Player guild ${opts.guildId} memakai node "${node.name}"`);
                return player;
            } catch (e) {
                errTerakhir = e;
                markBad(node.name, `${e?.status || ''} ${e?.message || e}`.trim());
            }
        }
        throw errTerakhir;
    }

    kazagumo.shoukaku.on('error', (name, error) => console.error(`[MusicBot] Node "${name}" error:`, error?.message || error));
    kazagumo.shoukaku.on('ready', (name) => console.log(`[MusicBot] ✅ Node "${name}" terhubung`));
    kazagumo.shoukaku.on('disconnect', (name) => console.warn(`[MusicBot] ⚠️ Node "${name}" terputus`));
    client.on('error', (e) => console.error('[MusicBot] Client error:', e));

    const timeoutsBahuMusik = new Map();
    let pesanPanelUtama = null;

    const updatePanel = async (payload) => {
        if (!pesanPanelUtama) return;
        await pesanPanelUtama.edit(payload).catch(() => null);
    };

    const clearIdleTimer = (guildId) => {
        if (timeoutsBahuMusik.has(guildId)) {
            clearTimeout(timeoutsBahuMusik.get(guildId));
            timeoutsBahuMusik.delete(guildId);
        }
    };

    const jadwalkanKeluar = (player) => {
        if (timeoutsBahuMusik.has(player.guildId)) return;
        const timer = setTimeout(async () => {
            try {
                const aktif = kazagumo.players.get(player.guildId);
                if (aktif) {
                    aktif.destroy();
                } else {
                    const guild = client.guilds.cache.get(player.guildId);
                    if (guild?.members.me?.voice.channelId) guild.members.me.voice.disconnect().catch(() => null);
                }
                const channel = client.channels.cache.get(player.textId);
                if (channel) {
                    const notif = await channel.send('💤 *Disconnected automatically after 5 minutes of inactivity.*').catch(() => null);
                    hapusNanti(notif, 7000);
                }
            } catch (e) {
                console.error('[MusicBot] Gagal auto-disconnect:', e);
            } finally {
                timeoutsBahuMusik.delete(player.guildId);
            }
        }, IDLE_DISCONNECT_MS);
        timeoutsBahuMusik.set(player.guildId, timer);
    };

    // ---------------- PANEL ----------------
    const buatPanelStandby = () => {
        const embed = new EmbedBuilder()
            .setColor('#2B2D31')
            .setAuthor({ name: '💤 Player Standby', iconURL: 'https://i.imgur.com/b9t7Zun.gif' })
            .setTitle('System Standby • Idle Mode')
            .setDescription('📡 **Direct Chat Control Activated**\nNo prefixes required. Input any track title or paste a direct URL below to initialize the audio stream')
            .setFooter({ text: 'ThroveFM • No-Prefix Controller', iconURL: client.user?.displayAvatarURL() });

        const rowControls = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('disabled_pause').setEmoji('⏯️').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_stop').setEmoji('⏹️').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        const rowVolume = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('disabled_voldown').setEmoji('⬇').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_voltxt').setLabel('🔊 Vol: 5').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('disabled_volup').setEmoji('⬆').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        return { embeds: [embed], components: [rowControls, rowVolume] };
    };

    const buatPanelPlayer = (player) => {
        const track = player.queue.current;
        if (!track) return buatPanelStandby();

        const totalAntrean = player.queue.length;
        if (!player.loopMode) player.loopMode = 'none';
        if (typeof player.shuffleMode === 'undefined') player.shuffleMode = false;
        if (typeof player.skalaVolume === 'undefined') player.skalaVolume = 5;

        let teksLoop = '`❌ Off`';
        if (player.loopMode === 'queue' && totalAntrean > 0) teksLoop = '`🔁 Loop Playlist (Semua)`';
        if (player.loopMode === 'track') teksLoop = '`🔂 Loop Track (Satu Lagu Ini)`';

        let teksNextUp;
        if (totalAntrean > 0) {
            const next = player.queue[0];
            teksNextUp = `⏭️ **Next Up (Lagu Berikutnya):**\n└ **${next.title}**\n   *Requested By: ${next.requester || '@Unknown'} — \`${formatDurasi(next.length)}\`*\n\n`;
        } else {
            teksNextUp = `⏭️ **Next Up (Lagu Berikutnya):**\n└ \`No upcoming tracks in queue\`\n\n`;
        }

        let deskripsi = teksNextUp +
            `👤 **Requester:** ${track.requester || '@Unknown'}\n` +
            `🔊 **Voice Channel:** <#${player.voiceId}>\n` +
            `⏱️ **Duration:** \`${formatDurasi(track.length || 0)}\`\n` +
            `📊 **Queue:** \`${totalAntrean} lagu tersisa\`\n` +
            `🔁 **Loop Status:** ${teksLoop}`;
        if (totalAntrean > 0) deskripsi += `\n🎲 **Shuffle Status:** ${player.shuffleMode ? '`🔀 On (Acak)`' : '`❌ Off`'}`;

        const embed = new EmbedBuilder()
            .setColor(player.paused ? '#F5B041' : '#2B2D31')
            .setAuthor({ name: player.paused ? '⏸️ Music Paused' : '🎶 Now playing', iconURL: 'https://i.imgur.com/b9t7Zun.gif' })
            .setTitle(track.title)
            .setURL(track.uri || 'https://youtube.com')
            .setThumbnail(track.thumbnail || 'https://i.imgur.com/8Q5F9X8.png')
            .setDescription(deskripsi)
            .setFooter({ text: 'ThroveFM • No prefix needed! Drop your song title or link below 👇', iconURL: client.user?.displayAvatarURL() });

        const nav = [
            new ButtonBuilder().setCustomId('btn_pause_resume').setEmoji('⏯️').setStyle(player.paused ? ButtonStyle.Success : ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
        ];
        let emojiLoop = '🔁';
        let warnaLoop = ButtonStyle.Secondary;
        if (player.loopMode === 'queue' && totalAntrean > 0) warnaLoop = ButtonStyle.Success;
        else if (player.loopMode === 'track') { emojiLoop = '🔂'; warnaLoop = ButtonStyle.Primary; }
        nav.push(new ButtonBuilder().setCustomId('btn_loop').setEmoji(emojiLoop).setStyle(warnaLoop));
        if (totalAntrean > 0) {
            nav.push(new ButtonBuilder().setCustomId('btn_shuffle').setEmoji('🔀').setStyle(player.shuffleMode ? ButtonStyle.Primary : ButtonStyle.Secondary));
        }
        nav.push(new ButtonBuilder().setCustomId('btn_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger));

        let emojiSpeaker = '🔊';
        if (player.skalaVolume === 0) emojiSpeaker = '🔇';
        else if (player.skalaVolume <= 3) emojiSpeaker = '🔈';
        else if (player.skalaVolume <= 7) emojiSpeaker = '🔉';

        const rowVolume = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_vol_down').setEmoji('⬇').setStyle(ButtonStyle.Secondary).setDisabled(player.skalaVolume <= 0),
            new ButtonBuilder().setCustomId('txt_vol_indicator').setLabel(`${emojiSpeaker} Vol: ${player.skalaVolume}`)
                .setStyle(player.skalaVolume === 0 ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId('btn_vol_up').setEmoji('⬆').setStyle(ButtonStyle.Secondary).setDisabled(player.skalaVolume >= 10),
        );

        return { embeds: [embed], components: [new ActionRowBuilder().addComponents(nav), rowVolume] };
    };

    // ---------------- PROSES LAGU ----------------
    async function prosesInputLagu(guildId, textChannel, member, query) {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            const reply = await textChannel.send(`❌ <@${member.id}>, Kamu harus masuk ke voice channel terlebih dahulu!`).catch(() => null);
            return hapusNanti(reply);
        }

        clearIdleTimer(guildId);

        const isSpotify = /https?:\/\/(open|play)\.spotify\.com\/(intl-[a-z]+\/)?(track|playlist|album)\//i.test(query);
        const statusMsg = await textChannel.send(
            isSpotify ? '🎵 Membedah link Spotify & mencari audionya...' : `🔍 Mencari \`${query.slice(0, 100)}\`...`
        ).catch(() => null);

        try {
            const susunanLagu = [];
            let namaPlaylist = null;

            if (isSpotify) {
                if (query.includes('/track/')) {
                    const data = await spotifyGet.getData(query);
                    const artis = data.artists ? data.artists.map(a => a.name).join(', ') : data.artist;
                    susunanLagu.push(`${artis} - ${data.name}`);
                } else {
                    const tracks = await spotifyGet.getTracks(query);
                    try {
                        namaPlaylist = (await spotifyGet.getData(query)).name;
                    } catch {
                        namaPlaylist = query.includes('/playlist/') ? 'Spotify Playlist' : 'Spotify Album';
                    }
                    for (const t of tracks) {
                        const artis = t.artists ? t.artists.map(a => a.name).join(', ') : t.artist;
                        susunanLagu.push(`${artis} - ${t.name}`);
                    }
                }
            } else {
                susunanLagu.push(query);
            }

            if (susunanLagu.length === 0) {
                await statusMsg?.edit('❌ Gagal membedah struktur data link Spotify.').catch(() => null);
                return hapusNanti(statusMsg);
            }

            const player = await buatPlayerDenganFallback({
                guildId,
                textId: textChannel.id,
                voiceId: voiceChannel.id,
                deaf: true,
            });
            const nodePlayer = player.shoukaku?.node?.name;

            if (typeof player.skalaVolume === 'undefined') {
                player.skalaVolume = 5;
                player.setVolume(50);
            }

            if (isSpotify && namaPlaylist) {
                await statusMsg?.edit(`⏳ Sedang memasukkan lagu dari **${namaPlaylist}** ke antrean...`).catch(() => null);
                let masuk = 0;
                for (const teks of susunanLagu) {
                    const res = await kazagumo.search(teks, { requester: member.user, engine: SEARCH_ENGINE, nodeName: nodePlayer }).catch(() => null);
                    if (res?.tracks?.length) { player.queue.add(res.tracks[0]); masuk++; }
                }
                const notif = await textChannel.send(`✅ Sukses memuat **${masuk}/${susunanLagu.length} lagu** dari Spotify **${namaPlaylist}**!`).catch(() => null);
                hapusNanti(notif);
            } else {
                const res = await kazagumo.search(susunanLagu[0], { requester: member.user, engine: SEARCH_ENGINE, nodeName: nodePlayer });
                if (!res?.tracks?.length) {
                    await statusMsg?.edit('❌ Audio tidak ditemukan. Node Lavalink mungkin sedang bermasalah dengan sumber ini.').catch(() => null);
                    if (!player.queue.current && player.queue.length === 0) player.destroy();
                    return hapusNanti(statusMsg);
                }
                if (res.type === 'PLAYLIST') {
                    for (const t of res.tracks) player.queue.add(t);
                    hapusNanti(await textChannel.send(`✅ Berhasil menambahkan Playlist **${res.playlistName}**.`).catch(() => null));
                } else {
                    player.queue.add(res.tracks[0]);
                    hapusNanti(await textChannel.send(`✅ Ditambahkan ke antrean: **${res.tracks[0].title}**`).catch(() => null));
                }
            }

            await updatePanel(buatPanelPlayer(player));
            if (!player.playing && !player.paused) player.play();
            await statusMsg?.delete().catch(() => null);
        } catch (err) {
            console.error('[MusicBot] Gagal memproses lagu:', err);
            await statusMsg?.delete().catch(() => null);
            hapusNanti(await textChannel.send('❌ Terjadi kesalahan saat memproses lagu.').catch(() => null));
        }
    }

    // ---------------- EVENTS DISCORD ----------------
    client.once('clientReady', async () => {
        console.log(`[MusicBot] ✅ Online sebagai ${client.user.tag}`);
        client.user.setActivity('ThroveFM Audio Stream', { type: 2 });

        try {
            const channel = await client.channels.fetch(CHANNEL_MUSIK_ID).catch(() => null);
            if (!channel) {
                console.warn(`[MusicBot] Channel musik ${CHANNEL_MUSIK_ID} tidak ditemukan / bot tidak punya akses.`);
                return;
            }
            const messages = await channel.messages.fetch({ limit: 50 });
            if (messages.size > 0) await channel.bulkDelete(messages, true).catch(() => null);
            pesanPanelUtama = await channel.send(buatPanelStandby());
        } catch (e) {
            console.error('[MusicBot] Gagal inisialisasi channel musik:', e);
        }
    });

    client.on('messageCreate', async (message) => {
        try {
            if (message.author.bot || !message.guild || !message.member) return;
            if (message.channel.id !== CHANNEL_MUSIK_ID) return;

            const query = message.content.trim();
            await message.delete().catch(() => null);
            if (query.length > 0) await prosesInputLagu(message.guild.id, message.channel, message.member, query);
        } catch (e) {
            console.error('[MusicBot] messageCreate error:', e);
        }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
            if (!interaction.isButton() || !interaction.guild) return;

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
                case 'btn_loop': {
                    if (player.queue.length === 0) {
                        player.loopMode = player.loopMode === 'none' ? 'track' : 'none';
                    } else if (player.loopMode === 'none') player.loopMode = 'queue';
                    else if (player.loopMode === 'queue') player.loopMode = 'track';
                    else player.loopMode = 'none';
                    player.setLoop(player.loopMode);
                    break;
                }
                case 'btn_shuffle':
                    if (player.queue.length >= 2) {
                        player.shuffleMode = !player.shuffleMode;
                        if (player.shuffleMode) player.queue.shuffle();
                    }
                    break;
                case 'btn_vol_down':
                    if (player.skalaVolume > 0) { player.skalaVolume -= 1; player.setVolume(player.skalaVolume * 10); }
                    break;
                case 'btn_vol_up':
                    if (player.skalaVolume < 10) { player.skalaVolume += 1; player.setVolume(player.skalaVolume * 10); }
                    break;
            }

            const valid = kazagumo.players.get(interaction.guild.id);
            await updatePanel(valid?.queue.current ? buatPanelPlayer(valid) : buatPanelStandby());
        } catch (e) {
            console.error('[MusicBot] interactionCreate error:', e);
        }
    });

    // ---------------- EVENTS KAZAGUMO ----------------
    kazagumo.on('playerStart', async (player) => {
        clearIdleTimer(player.guildId);
        await updatePanel(buatPanelPlayer(player));
    });

    kazagumo.on('playerEnd', (player) => {
        setTimeout(async () => {
            try {
                if (!player.queue.current && player.queue.length === 0) {
                    await updatePanel(buatPanelStandby());
                    jadwalkanKeluar(player);
                } else {
                    await updatePanel(buatPanelPlayer(player));
                }
            } catch (e) {
                console.error('[MusicBot] playerEnd error:', e);
            }
        }, 500);
    });

    kazagumo.on('playerDestroy', async () => {
        await updatePanel(buatPanelStandby());
    });

    kazagumo.on('playerException', (player, data) => {
        console.error('[MusicBot] Track exception:', data?.exception?.message || data);
    });

    kazagumo.on('queueEnd', async (player) => {
        await updatePanel(buatPanelStandby());
        if (kazagumo.players.get(player.guildId)) jadwalkanKeluar(player);
    });

    client.login(token).catch((e) => {
        console.error('[MusicBot] Login gagal (cek DISCORD_TOKEN):', e.message);
        process.exit(1);
    });

    return client;
}

// ---------------- WEB SERVER (untuk Render + ping keep-alive) ----------------
const app = express();
app.get('/', (req, res) => res.send('ThroveFM Bot is Streaming Live! 📻'));
app.get('/health', (req, res) => res.json({ ok: true }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[Web] Server aktif di port ${port}`));

process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

startMusicBot();
