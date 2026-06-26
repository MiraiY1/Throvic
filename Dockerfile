FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm install
RUN chmod +x start.sh
EXPOSE 7860
CMD ["./start.sh"]
