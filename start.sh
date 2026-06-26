#!/bin/bash

# 1. Perintah untuk download Lavalink.jar otomatis jika filenya belum ada
if [ ! -f Lavalink.jar ]; then
  echo "Mendownload Lavalink.jar dari server resmi..."
  curl -L https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar -o Lavalink.jar
fi

# 2. Buat folder plugins otomatis dan download plugin YouTube terbaru
mkdir -p plugins
if [ ! -f plugins/youtube-plugin-1.18.1.jar ]; then
  echo "Mendownload YouTube Plugin untuk Lavalink..."
  curl -L "https://github.com/lavalink-devs/youtube-source/releases/download/1.18.1/youtube-plugin-1.18.1.jar" -o plugins/youtube-plugin-1.18.1.jar
fi

# 3. Jalankan Lavalink dan bot Node.js secara bersamaan
java -jar Lavalink.jar &
node index.js