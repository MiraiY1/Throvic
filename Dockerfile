FROM node:22-bookworm-slim

# Install Java, ffmpeg, dan Python (wajib untuk yt-dlp-exec)
RUN apt-get update && apt-get install -y \
    openjdk-17-jre \
    ffmpeg \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy semua file bot ke dalam container
COPY . .

# Install dependencies Node.js
RUN npm install

# Beri izin eksekusi untuk start script
RUN chmod +x start.sh

# Hugging Face mewajibkan port 7860 terbuka
EXPOSE 7860

CMD ["./start.sh"]