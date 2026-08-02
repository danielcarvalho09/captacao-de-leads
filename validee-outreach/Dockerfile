FROM node:20-slim

WORKDIR /app

# Instala bibliotecas de sistema que o Chrome precisa num container headless Linux,
# antes de tentar baixar o Chrome. Isso evita que o npx puppeteer install falhe.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libx11-6 libx11-xcb1 libxcb1 libxrandr2 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Baixa o Chrome sem tentar instalar mais dependencias (ja instalamos acima).
# PUPPETEER_CACHE_DIR=/.cache/puppeteer coloca o download num diretorio persistente.
RUN PUPPETEER_CACHE_DIR=/.cache/puppeteer npx puppeteer browsers install chrome

COPY src ./src
COPY config ./config

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/web/server.js"]
