FROM node:20-slim

# Instalar Chromium y sus dependencias del sistema
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Decirle a Puppeteer que use el Chromium del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY . .
RUN cd backend && npm install

# Copia cards.json a /app/seeds/ — fuera de /app/data/ que será sobreescrito
# por el volumen de Railway. Usado para sembrar el volumen en el primer arranque.
RUN mkdir -p /app/seeds && cp /app/data/cards.json /app/seeds/cards.json

CMD ["node", "backend/server.js"]
