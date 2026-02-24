FROM node:20-slim

# Instalar Chromium, fuentes, curl y utilidades DNS
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    dnsutils \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Fallback DNS — inject Google DNS at runtime (resolv.conf is read-only at build time)
# Railway containers can fail DNS for some .com.do domains
RUN printf '#!/bin/sh\nif [ -w /etc/resolv.conf ]; then\n  grep -q "8.8.8.8" /etc/resolv.conf || echo "nameserver 8.8.8.8" >> /etc/resolv.conf\n  grep -q "8.8.4.4" /etc/resolv.conf || echo "nameserver 8.8.4.4" >> /etc/resolv.conf\nfi\nexec "$@"\n' > /usr/local/bin/dns-fix.sh && chmod +x /usr/local/bin/dns-fix.sh
ENTRYPOINT ["/usr/local/bin/dns-fix.sh"]

# Decirle a Puppeteer que use el Chromium del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Bust Docker cache — change this value to force Railway to re-COPY
ARG CACHEBUST=20260222
COPY . .
RUN cd backend && npm ci

# Copia cards.json a /app/seeds/ — fuera de /app/data/ que será sobreescrito
# por el volumen de Railway. Usado para sembrar el volumen en el primer arranque.
RUN mkdir -p /app/seeds && cp /app/data/cards.json /app/seeds/cards.json

CMD ["node", "backend/server.js"]
