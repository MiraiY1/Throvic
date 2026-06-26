#!/bin/bash

# 1. Download Lavalink.jar otomatis jika belum ada
if [ ! -f Lavalink.jar ]; then
  echo "Mendownload Lavalink.jar dari server resmi..."
  wget -q https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar -O Lavalink.jar
fi

# 2. Buat folder plugins dan download YouTube plugin
mkdir -p plugins
if [ ! -f plugins/youtube-plugin-1.18.1.jar ]; then
  echo "Mendownload YouTube Plugin untuk Lavalink..."
  wget -q "https://github.com/lavalink-devs/youtube-source/releases/download/1.18.1/youtube-plugin-1.18.1.jar" -O plugins/youtube-plugin-1.18.1.jar
fi

# 3. Jalankan Lavalink di background
java -jar Lavalink.jar &

# 4. Tunggu Lavalink ready (port 2333 terbuka)
echo "Menunggu Lavalink siap..."
for i in $(seq 1 60); do
  if nc -z 127.0.0.1 2333 2>/dev/null; then
    echo "Lavalink siap! Memulai bot..."
    break
  fi
  sleep 2
done

# 5. Jalankan bot
node index.js
