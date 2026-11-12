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
const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, MessageFlags } = require('discord.js');
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
    // 403 = kebijakan node (bot tidak diizinkan) → 6 jam. 429 = cuma kebanyakan request → 1 menit.
    const r = String(reason);
    const lama = /\b403\b/.test(r) ? 6 * 60 * 60 * 1000
        : /\b429\b/.test(r) ? 60 * 1000
        : BAD_NODE_COOLDOWN_MS;
    badNodes.set(name, Date.now() + lama);
    console.warn(`[MusicBot] ⛔ Node "${name}" dilewati ${Math.round(lama / 60000)} menit: ${reason}`);
};
const nodeSiap = (nodes) => {
    const tersambung = [...nodes.values()].filter(n => n.state === 1 /* CONNECTED */);
    const bagus = tersambung.filter(n => !isBad(n.name)).sort((a, b) => a.penalties - b.penalties);
    if (bagus.length) return bagus;
    // Semua sedang "diistirahatkan": tetap coba, mulai dari yang paling cepat selesai istirahatnya.
    // Lebih baik mencoba daripada bot macet sampai harus redeploy.
    return tersambung.sort((a, b) => (badNodes.get(a.name) || 0) - (badNodes.get(b.name) || 0));
};
const tidur = (ms) => new Promise(r => setTimeout(r, ms));
const MAKS_PLAYLIST = 200;     // batas lagu per playlist Spotify
const JEDA_CARI_MS = 800;      // jeda antar pencarian supaya node tidak menganggap spam

// Node publik cadangan (diambil dari lavalink-list.ajieblogs.eu.org, Nov 2026).
// Dipakai bersama node dari env LAVALINK_NODES. Matikan dengan LAVALINK_DEFAULTS=off.
const DEFAULT_NODES = [
    {"name": "millohost-id", "url": "lava-v4.millohost.my.id:443", "auth": "https://discord.gg/mjS5J2K3ep", "secure": true},
    {"name": "jirayu-th", "url": "lavalink.jirayu.net:443", "auth": "youshallnotpass", "secure": true},
    {"name": "nazha", "url": "lavalink.nazha.online:443", "auth": "nazhafreelava", "secure": true},
    {"name": "g3v-uk", "url": "lava.g3v.co.uk:9008", "auth": "lavalinklol", "secure": false},
    {"name": "nexcloud", "url": "n3.nexcloud.in:2026", "auth": "nexcloud", "secure": false},
    {"name": "vexanode", "url": "omega.vexanode.cloud:2031", "auth": "https://discord.vexanode.cloud", "secure": false},
    {"name": "kasawa", "url": "lava2.kasawa.pro:2334", "auth": "youshallnotpass", "secure": false},
    {"name": "minecuta", "url": "lavav4.minecuta.com:2333", "auth": "discord.gg/gKuXdHs", "secure": false}
];

function gabungNodes(dariEnv) {
    const hasil = [...dariEnv];
    if (String(process.env.LAVALINK_DEFAULTS || '').toLowerCase() === 'off') return hasil;
    const sudahAda = new Set(hasil.map(n => n.url.toLowerCase()));
    const namaDipakai = new Set(hasil.map(n => n.name));
    for (const n of DEFAULT_NODES) {
        if (sudahAda.has(n.url.toLowerCase())) continue;
        hasil.push({ ...n, name: namaDipakai.has(n.name) ? `${n.name}-def` : n.name });
    }
    return hasil;
}

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
    const nodes = gabungNodes(parseNodes(process.env.LAVALINK_NODES));
    console.log(`[MusicBot] ${nodes.length} node Lavalink dikonfigurasi`);
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

    // Hapus player dengan paksa. Kalau node menolak (403/429), Kazagumo bisa meninggalkan
    // player "basi" (sudah keluar voice tapi masih tercatat) — itu yang bikin bot macet.
    async function hancurkan(guildId) {
        hentikanWatchdog(guildId);
        const p = kazagumo.players.get(guildId);
        if (p) {
            try { await p.destroy(); }
            catch (e) { console.warn('[MusicBot] destroy ditolak node (diabaikan):', e?.status || e?.message || e); }
        }
        kazagumo.players.delete(guildId);
        try { kazagumo.shoukaku.connections.get(guildId)?.disconnect(); } catch { /* abaikan */ }
        kazagumo.shoukaku.connections.delete(guildId);
        kazagumo.shoukaku.players.delete(guildId);
    }

    const playerBasi = (p) => !p.voiceId || p.state >= 2 /* DISCONNECTING/DISCONNECTED/DESTROY* */;

    // Buat player, coba node satu per satu sampai ada yang mau.
    async function buatPlayerDenganFallback(opts) {
        const ada = kazagumo.players.get(opts.guildId);
        if (ada && !playerBasi(ada)) return ada;
        if (ada) await hancurkan(opts.guildId);
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
                    await hancurkan(player.guildId);
                    await updatePanel(buatPanelStandby());
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

    // ---------------- PENCARIAN & PLAYLIST ----------------
    // Kazagumo menelan error REST saat search (hasilnya kosong), jadi kosong = coba lagi sekali setelah jeda.
    async function cariLagu(teks, requester, nodeName) {
        for (let coba = 0; coba < 2; coba++) {
            const res = await kazagumo.search(teks, { requester, engine: SEARCH_ENGINE, nodeName }).catch(() => null);
            if (res?.tracks?.length) return res;
            if (coba === 0) await tidur(3000);
        }
        return null;
    }

    async function muatSisaPlaylist(player, sisa, requester, namaPlaylist, textChannel, total) {
        let masuk = 1;
        let gagalBeruntun = 0;
        for (const teks of sisa) {
            await tidur(JEDA_CARI_MS);
            const aktif = kazagumo.players.get(player.guildId);
            if (!aktif) return; // player sudah dihapus / di-stop
            const res = await cariLagu(teks, requester, aktif.shoukaku?.node?.name);
            if (res?.tracks?.length) {
                aktif.queue.add(res.tracks[0]);
                masuk++;
                gagalBeruntun = 0;
                if (masuk % 10 === 0) await updatePanel(buatPanelPlayer(aktif));
            } else if (++gagalBeruntun >= 5) {
                // Node kemungkinan sedang membatasi kita — istirahat sebentar lalu lanjut
                console.warn('[MusicBot] Pencarian playlist gagal beruntun, jeda 20 detik');
                await tidur(20000);
                gagalBeruntun = 0;
            }
        }
        const aktif = kazagumo.players.get(player.guildId);
        if (aktif?.queue.current) await updatePanel(buatPanelPlayer(aktif));
        hapusNanti(await textChannel.send(`✅ Selesai memuat **${masuk}/${total} lagu** dari Spotify **${namaPlaylist}**.`).catch(() => null), 8000);
    }

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
                // Cari lagu pertama dulu supaya musik langsung jalan; sisanya dimuat pelan-pelan di latar belakang.
                const daftar = susunanLagu.slice(0, MAKS_PLAYLIST);
                let pertama = null;
                let idx = 0;
                while (idx < daftar.length && !pertama && idx < 5) {
                    const res = await cariLagu(daftar[idx++], member.user, nodePlayer);
                    if (res?.tracks?.length) pertama = res.tracks[0];
                }
                if (!pertama) {
                    await statusMsg?.edit('❌ Lagu dari playlist itu tidak ditemukan. Server musik mungkin sedang sibuk, coba lagi sebentar lagi.').catch(() => null);
                    if (!player.queue.current && player.queue.length === 0) await hancurkan(guildId);
                    return hapusNanti(statusMsg);
                }
                player.queue.add(pertama);
                const info = susunanLagu.length > MAKS_PLAYLIST ? ` (dibatasi ${MAKS_PLAYLIST} lagu pertama)` : '';
                hapusNanti(await textChannel.send(`⏳ Memutar lagu pertama dari **${namaPlaylist}**. ${daftar.length - 1} lagu lainnya dimuat bertahap${info}...`).catch(() => null), 8000);
                muatSisaPlaylist(player, daftar.slice(idx), member.user, namaPlaylist, textChannel, daftar.length)
                    .catch(e => console.error('[MusicBot] Gagal memuat sisa playlist:', e));
            } else {
                const res = await kazagumo.search(susunanLagu[0], { requester: member.user, engine: SEARCH_ENGINE, nodeName: nodePlayer });
                if (!res?.tracks?.length) {
                    await statusMsg?.edit('❌ Audio tidak ditemukan. Node Lavalink mungkin sedang bermasalah dengan sumber ini.').catch(() => null);
                    if (!player.queue.current && player.queue.length === 0) await hancurkan(guildId);
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
            if (!player.playing && !player.paused) {
                // Mulai pengecekan sekarang juga: ada node yang tidak pernah kirim sinyal "mulai".
                Promise.resolve(player.play()).catch(async (e) => {
                    if (e?.status === 429) {
                        // Cuma dibatasi sementara: tunggu lalu coba lagi di node yang sama
                        await tidur(5000);
                        if (kazagumo.players.get(guildId) !== player) return;
                        return Promise.resolve(player.play()).catch(e2 =>
                            pindahNode(player, `play ditolak: ${e2?.status || ''} ${e2?.message || e2}`.trim()));
                    }
                    return pindahNode(player, `play ditolak: ${e?.status || ''} ${e?.message || e}`.trim());
                });
                mulaiWatchdog(player);
            }
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

            let player = kazagumo.players.get(interaction.guild.id);
            if (player && playerBasi(player)) {
                await hancurkan(interaction.guild.id);
                await updatePanel(buatPanelStandby());
                player = null;
            }
            if (!player) {
                return interaction.reply({ content: '💤 Tidak ada lagu yang sedang diputar. Ketik judul lagu di channel ini.', flags: MessageFlags.Ephemeral }).catch(() => null);
            }

            if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== player.voiceId) {
                return interaction.reply({ content: '❌ Kamu harus berada di Voice Channel yang sama untuk mengontrol musik!', flags: MessageFlags.Ephemeral });
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

    // ---------------- FAILOVER NODE ----------------
    // Node publik kadang "mulai" memutar tapi audionya tidak jalan (posisi diam di 0).
    // Kalau begitu, player dipindah ke node lain dan lagu dilanjutkan.
    const watchdogs = new Map();   // guildId -> timeout
    const percobaan = new Map();   // guildId -> jumlah pindah node berturut-turut
    const WATCHDOG_MS = 15000;

    const hentikanWatchdog = (guildId) => {
        if (watchdogs.has(guildId)) { clearTimeout(watchdogs.get(guildId)); watchdogs.delete(guildId); }
    };

    async function pindahNode(player, alasan) {
        const guildId = player.guildId;
        hentikanWatchdog(guildId);
        const namaLama = player.shoukaku?.node?.name;
        if (namaLama) markBad(namaLama, alasan);

        const ke = (percobaan.get(guildId) || 0) + 1;
        percobaan.set(guildId, ke);
        const channel = client.channels.cache.get(player.textId);

        // Simpan keadaan sebelum player lama dihapus
        const simpan = {
            textId: player.textId,
            voiceId: player.voiceId,
            current: player.queue.current,
            sisa: [...player.queue],
            loop: player.loopMode || 'none',
            vol: typeof player.skalaVolume === 'number' ? player.skalaVolume : 5,
        };
        await hancurkan(guildId);

        if (ke > Math.min(kazagumo.shoukaku.nodes.size, 5) || !simpan.voiceId || !simpan.current) {
            percobaan.delete(guildId);
            console.error(`[MusicBot] Failover berhenti untuk guild ${guildId} (percobaan ${ke})`);
            hapusNanti(await channel?.send('❌ Semua server musik sedang bermasalah. Coba lagi beberapa menit lagi.').catch(() => null), 8000);
            await updatePanel(buatPanelStandby());
            return;
        }

        try {
            const baru = await buatPlayerDenganFallback({ guildId, textId: simpan.textId, voiceId: simpan.voiceId, deaf: true });
            const nodeBaru = baru.shoukaku?.node?.name;
            baru.skalaVolume = simpan.vol;
            baru.setVolume(simpan.vol * 10);
            baru.loopMode = simpan.loop;

            // Cari ulang lagu yang sedang diputar lewat node baru
            let track = simpan.current;
            const res = await kazagumo.search(simpan.current.uri || simpan.current.title,
                { requester: simpan.current.requester, engine: SEARCH_ENGINE, nodeName: nodeBaru }).catch(() => null);
            if (res?.tracks?.length) track = res.tracks[0];
            baru.queue.add(track);
            for (const t of simpan.sisa) baru.queue.add(t);
            if (simpan.loop !== 'none') baru.setLoop(simpan.loop);

            console.log(`[MusicBot] 🔁 Guild ${guildId} pindah dari "${namaLama}" ke "${nodeBaru}"`);
            await updatePanel(buatPanelPlayer(baru));
            await baru.play();
            mulaiWatchdog(baru);
        } catch (e) {
            console.error('[MusicBot] Gagal pindah node:', e?.status || '', e?.message || e);
            const p = kazagumo.players.get(guildId);
            if (p) {
                pindahNode(p, `gagal setelah pindah: ${e?.status || ''} ${e?.message || e}`.trim()).catch(() => null);
            } else {
                percobaan.delete(guildId);
                hapusNanti(await channel?.send('❌ Server musik sedang bermasalah. Coba kirim lagunya lagi.').catch(() => null), 8000);
                await updatePanel(buatPanelStandby());
            }
        }
    }

    function mulaiWatchdog(player) {
        hentikanWatchdog(player.guildId);
        const trackAwal = player.queue.current?.identifier;
        const timer = setTimeout(() => {
            watchdogs.delete(player.guildId);
            const aktif = kazagumo.players.get(player.guildId);
            if (!aktif || aktif.paused || aktif.queue.current?.identifier !== trackAwal) return;
            if ((aktif.shoukaku?.position || 0) < 1000) {
                pindahNode(aktif, 'audio tidak jalan (posisi diam)').catch(e => console.error('[MusicBot] failover error:', e));
            } else {
                percobaan.delete(player.guildId); // node ini berfungsi
            }
        }, WATCHDOG_MS);
        watchdogs.set(player.guildId, timer);
    }

    // ---------------- EVENTS KAZAGUMO ----------------
    kazagumo.on('playerStart', async (player) => {
        clearIdleTimer(player.guildId);
        mulaiWatchdog(player);
        await updatePanel(buatPanelPlayer(player));
    });

    kazagumo.on('playerStuck', (player, data) => {
        console.warn('[MusicBot] Track stuck:', data?.thresholdMs);
        pindahNode(player, 'track stuck').catch(e => console.error('[MusicBot] failover error:', e));
    });

    kazagumo.on('playerClosed', (player, data) => {
        console.warn(`[MusicBot] Voice websocket ditutup (code ${data?.code}): ${data?.reason || ''}`);
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

    kazagumo.on('playerDestroy', async (player) => {
        hentikanWatchdog(player.guildId);
        await updatePanel(buatPanelStandby());
    });

    kazagumo.on('playerException', (player, data) => {
        const pesan = data?.exception?.message || JSON.stringify(data);
        console.error(`[MusicBot] Track exception di node "${player.shoukaku?.node?.name}":`, pesan);
        // Jangan pindah node di sini: Kazagumo sudah otomatis lanjut ke lagu berikutnya.
        // Cukup tandai node-nya supaya permintaan berikutnya memakai node lain.
        hentikanWatchdog(player.guildId);
        const nama = player.shoukaku?.node?.name;
        if (nama) markBad(nama, `track exception: ${pesan}`);
        const channel = client.channels.cache.get(player.textId);
        channel?.send('⚠️ Lagu gagal diputar di server musik ini. Kirim ulang judulnya, nanti dicoba lewat server lain.')
            .then(m => hapusNanti(m, 8000)).catch(() => null);
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
