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

# ENV (nao prefixo do RUN): o caminho precisa ser o mesmo na hora de baixar e
# na hora de rodar, senao o puppeteer nao encontra o Chrome em producao e a
# conexao do WhatsApp falha com "Failed to launch the browser process".
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
RUN npx puppeteer browsers install chrome

COPY src ./src

# Vai para /app/defaults, NAO para /app/config: em producao /app/config e um
# volume persistente que comeca vazio e esconderia o que a imagem trouxesse
# nesse caminho. O src/bootstrap.js copia daqui para o volume no boot, apenas
# o que ainda nao existe la (nunca sobrescreve config feita pelo usuario).
COPY config ./defaults

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/web/server.js"]
