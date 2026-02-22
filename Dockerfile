FROM node:20-slim

# Instalar Chromium, fuentes y utilidades DNS
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    dnsutils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Fallback DNS — Railway's container DNS can fail for some .com.do domains
RUN echo "nameserver 8.8.8.8" >> /etc/resolv.conf \
    && echo "nameserver 8.8.4.4" >> /etc/resolv.conf

# Decirle a Puppeteer que use el Chromium del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY . .
RUN cd backend && npm ci

# Copia cards.json a /app/seeds/ — fuera de /app/data/ que será sobreescrito
# por el volumen de Railway. Usado para sembrar el volumen en el primer arranque.
RUN mkdir -p /app/seeds && cp /app/data/cards.json /app/seeds/cards.json

CMD ["node", "backend/server.js"]
