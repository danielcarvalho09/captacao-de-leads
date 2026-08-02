FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --install-deps faz o proprio puppeteer descobrir e instalar as bibliotecas
# de sistema corretas pra essa versao do Chrome nessa versao do Debian (evita
# manter uma lista de pacotes apt na mao, que muda de nome entre versoes).
RUN npx puppeteer browsers install chrome --install-deps

COPY src ./src
COPY config ./config

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/web/server.js"]
