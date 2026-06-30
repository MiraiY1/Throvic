FROM eclipse-temurin:17-jre

WORKDIR /app

RUN apt-get update && apt-get install -y wget && \
    wget -q https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar -O Lavalink.jar && \
    mkdir -p plugins && \
    wget -q "https://github.com/lavalink-devs/youtube-source/releases/download/1.18.1/youtube-plugin-1.18.1.jar" -O plugins/youtube-plugin-1.18.1.jar && \
    rm -rf /var/lib/apt/lists/*

COPY application.yml .

EXPOSE 2333

CMD ["java", "-Xmx400m", "-Xms128m", "-jar", "Lavalink.jar"]
